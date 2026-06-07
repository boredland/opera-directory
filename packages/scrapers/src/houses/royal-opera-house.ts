import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchRendered, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Royal Opera House — Covent Garden, London (rebranded "Royal Ballet and Opera"
 * in 2024; English). The venue presents BOTH The Royal Opera AND The Royal Ballet
 * on its Main Stage and in the Linbury Theatre, so the adapter filters to opera.
 *
 * ROH ticketing is Tessitura, but production metadata lives on the marketing site
 * (rbo.org.uk; roh.org.uk 301s here). The site is a React SPA on a Prismic CMS —
 * no public Tessitura/TNEW JSON endpoint is exposed for repertoire — read with a
 * browser UA (the crawler UA is served a 500) in two passes:
 *   1. LISTING (plain fetch): `/tickets-and-events` ships the whole what's-on set
 *      in `window.__REACT_QUERY_DEHYDRATED_STATE__` (queryKey ["eventsPage"]). Each
 *      event carries `slug`, `title`, `performances[].date` (local ISO),
 *      `locations[]` (ids resolved against the page's `locations` lookup → Main
 *      Stage / Linbury Theatre), `tags[]`, and `isCancelled`. The opera/ballet
 *      split is tag id 921 "Opera and music" vs 922 "Ballet and dance" — keep 921.
 *   2. DETAIL: most `/tickets-and-events/{slug}-details` pages server-render their
 *      dehydrated state (queryKey ["singleProductionPage", slug]) inline, carrying
 *      `production.creatives[]` — a structured `{role, name}` list whose composer
 *      is the role "Music" or "Composer" (both occur) and whose other roles are
 *      ENGLISH function labels mapped to our slugs INSIDE this adapter. Some pages
 *      ship an empty cache and build the same credits client-side, so when the
 *      inline read finds no composer we render (last resort) and parse the credits
 *      from the DOM. A genuine opera has a composer; recitals/concerts (also tag
 *      921) carry none, so the composer requirement is the opera gate.
 *
 * `backfill` appends Wikidata (Q55018) for the deep past. Cast varies per night
 * and the site only prints it un-paired with roles on the cast/dates view, so
 * production-level cast is left empty rather than emitting role-less names.
 */

const BASE = "https://www.rbo.org.uk";
const LISTING_URL = `${BASE}/tickets-and-events`;

/** The crawler UA is served a 500 error page; rbo.org.uk only answers a browser UA. */
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

/** Royal Opera House on Wikidata — Q55018, the Covent Garden venue, which is what
 *  carries productions (48 via P4647 location-of-first-performance / P272 production
 *  company; the company records "The Royal Opera" Q4266459 and the "Covent Garden
 *  Foundation" Q113069937 carry zero). Verified via wbsearchentities + a SPARQL
 *  count: Q55018 = "Royal Opera House", "opera house … in Covent Garden". */
const WIKIDATA_QID = "Q55018";

/** Prismic tag id for opera (vs id 922 "Ballet and dance"). Verified against the
 *  listing's own `tags` lookup: 921 = "Opera and music". */
const OPERA_TAG_ID = "921";

/** ENGLISH `creatives[].role` labels → our canonical function slugs (matched
 *  case-insensitively and de-pluralized, so "Lighting Designers" hits "lighting
 *  designer"). "Music" is consumed separately as the composer; unmapped labels
 *  (Libretto, Dialogue, …) are dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  designer: "set-designer",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "video-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

interface ListingEvent {
  id?: string;
  title?: string;
  slug?: string;
  description?: string;
  isCancelled?: boolean;
  tags?: string[];
  locations?: string[];
  performances?: { date?: string; performanceType?: string }[];
  imageResult?: { desktopPath?: string | null };
}

export async function scrapeRoyalOperaHouse(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const { events, locations } = await fetchListing(ctx);
    for (const ev of events) {
      if (!isOpera(ev)) continue;
      try {
        const prod = await buildProduction(ev, locations, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`royal-opera-house: production ${ev.slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("royal-opera-house: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("royal-opera-house: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "royal-opera-house", productions };
}

/** The what's-on listing ships the whole event set inline in the React Query
 *  dehydrated state; one plain fetch yields every event plus the id→title
 *  `locations` lookup (Main Stage / Linbury Theatre / …). */
async function fetchListing(
  ctx: FetchContext,
): Promise<{ events: ListingEvent[]; locations: Map<string, string> }> {
  const html = await fetchHtml(LISTING_URL, { ...ctx, userAgent: BROWSER_UA });
  const state = extractDehydratedState(html);
  const eventsPage = state?.queries?.find((q) => q.queryKey?.[0] === "eventsPage")?.state?.data
    ?.events;
  const events = (eventsPage?.events ?? []).filter((e): e is ListingEvent => !!e);
  const locations = new Map<string, string>();
  for (const loc of eventsPage?.locations ?? []) {
    if (loc?.id && loc.title) locations.set(loc.id, loc.title);
  }
  return { events, locations };
}

interface DehydratedQuery {
  queryKey?: unknown[];
  state?: {
    data?: {
      // ["eventsPage"]
      events?: {
        events?: (ListingEvent | null)[];
        locations?: ({ id?: string; title?: string } | null)[];
      };
      // ["singleProductionPage", slug]
      data?: { production?: ProductionData | null };
    };
  };
}

/** Pull `window.__REACT_QUERY_DEHYDRATED_STATE__` from the listing HTML. The
 *  assignment value is a single JSON object literal; brace-match it respecting
 *  string literals so embedded `{`/`}` in descriptions don't truncate it. */
function extractDehydratedState(html: string): { queries: DehydratedQuery[] } | null {
  const marker = "window.__REACT_QUERY_DEHYDRATED_STATE__";
  const at = html.indexOf(marker);
  if (at === -1) return null;
  const start = html.indexOf("{", at);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isOpera(ev: ListingEvent): boolean {
  return (ev.tags ?? []).includes(OPERA_TAG_ID) && !!ev.slug;
}

/** Read the `-details` page for the composer + creative team, then emit the
 *  production with the listing's performances. Returns null when there is no
 *  composer — the opera gate that drops recitals/concerts sharing the opera tag.
 *
 *  Most pages server-render their `production.creatives` inline (plain fetch);
 *  some serve an empty cache and only build the credits client-side, so when the
 *  inline read yields no composer we render and parse the credits from the DOM. */
async function buildProduction(
  ev: ListingEvent,
  locations: Map<string, string>,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const slug = ev.slug as string;
  const detailUrl = `${BASE}/tickets-and-events/${slug}-details`;
  const renderCtx = { ...ctx, userAgent: BROWSER_UA };

  const detailHtml = await fetchHtml(detailUrl, renderCtx);
  const production = singleProductionData(detailHtml, slug);
  const language = production?.language;
  let { composer, creative } = parseCreatives(production?.creatives ?? []);

  if (!composer) {
    const rendered = await fetchRendered(detailUrl, renderCtx, { waitMs: 9000 });
    ({ composer, creative } = parseDomCreatives(rendered));
  }
  if (!composer) return null;

  const performances = parsePerformances(ev, locations, window);
  if (performances.length === 0) return null;

  const title = stripHtml(ev.title ?? "") || slugToTitle(slug);
  if (!title) return null;

  return {
    source_production_id: `royal-opera-house/${slug}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(language),
    detail_url: detailUrl,
    image_url: ev.imageResult?.desktopPath ?? null,
    synopsis: ev.description ? stripHtml(ev.description) : null,
    creative_team: creative,
    cast: [],
    performances,
  };
}

interface ProductionData {
  creatives?: ({ role?: string; name?: string } | null)[];
  language?: string;
}

/** The `-details` page's dehydrated state (queryKey ["singleProductionPage", slug])
 *  holds the structured `production` object — read it from the same inline
 *  `__REACT_QUERY_DEHYDRATED_STATE__` the listing uses. */
function singleProductionData(html: string, slug: string): ProductionData | null {
  const state = extractDehydratedState(html);
  const query = state?.queries?.find(
    (q) => q.queryKey?.[0] === "singleProductionPage" && q.queryKey?.[1] === slug,
  );
  return query?.state?.data?.data?.production ?? null;
}

/** `production.creatives[]` is an ordered `{role, name}` list. The composer is the
 *  role labelled "Music" or "Composer" (the site uses both); every other role maps
 *  through CREATIVE_FUNCTIONS (unmapped roles dropped). */
function parseCreatives(creatives: ({ role?: string; name?: string } | null)[]): {
  composer: string | null;
  creative: RawCredit[];
} {
  let composer: string | null = null;
  const creative: RawCredit[] = [];
  const seen = new Set<string>();
  for (const entry of creatives) {
    const name = stripHtml(entry?.name ?? "");
    const label = normalizeLabel(stripHtml(entry?.role ?? ""));
    if (!name) continue;
    if (label === "music" || label === "composer") {
      composer ??= name;
      continue;
    }
    const fn = CREATIVE_FUNCTIONS[label];
    if (!fn) continue;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creative.push({ function: fn, name });
  }
  return { composer, creative };
}

/** The render fallback: pages that ship an empty cache build the same credits in
 *  the DOM as a flat label→name run anchored on a tag-wrapped `>Music<`/`>Composer<`
 *  (the description/meta copy is never tag-wrapped), stopping at the next section.
 *  Pairs are sequential; a label may carry several names joined by " and ". */
function parseDomCreatives(html: string): { composer: string | null; creative: RawCredit[] } {
  const anchor = html.search(/>\s*(?:Music|Composer)\s*</);
  if (anchor === -1) return { composer: null, creative: [] };
  const slice = html.slice(anchor, anchor + 8000);
  const stop = slice.search(/Reviews|Synopsis|eventDetails(?:Access|Footer)|data-roh="anchor/i);
  const block = stop === -1 ? slice : slice.slice(0, stop);

  const cells = block
    .split(/<[^>]+>/)
    .map((c) => decodeEntities(c).replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let composer: string | null = null;
  const creative: RawCredit[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < cells.length) {
    const label = normalizeLabel(cells[i] ?? "");
    const isComposer = label === "music" || label === "composer";
    const fn = CREATIVE_FUNCTIONS[label];
    if (!isComposer && !fn) {
      i++;
      continue;
    }
    const names: string[] = [];
    let j = i + 1;
    while (j < cells.length) {
      const cell = cells[j] ?? "";
      if (cell.toLowerCase() === "and") {
        j++;
        continue;
      }
      const next = normalizeLabel(cell);
      if (next === "music" || next === "composer" || CREATIVE_FUNCTIONS[next]) break;
      names.push(cell);
      j++;
      if (j < cells.length && (cells[j] ?? "").toLowerCase() !== "and") break;
    }
    if (isComposer) composer ??= names[0] ?? null;
    else if (fn) {
      for (const name of names) {
        const key = `${fn}|${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        creative.push({ function: fn, name });
      }
    }
    i = j;
  }
  return { composer, creative };
}

/** Listing `performances[].date` are local ISO ("YYYY-MM-DDThh:mm:ss+01:00"); the
 *  venue is the production's single Main Stage / Linbury Theatre location. Honors
 *  window.since; cancelled is the listing's `isCancelled` flag. */
function parsePerformances(
  ev: ListingEvent,
  locations: Map<string, string>,
  window: ScrapeWindow,
): RawPerformance[] {
  const room = (ev.locations ?? []).map((id) => locations.get(id)).find(Boolean) ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const perf of ev.performances ?? []) {
    const m = (perf.date ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
    if (!m) continue;
    const date = m[1] as IsoDate;
    const time = m[2] ?? null;
    if (window.since && date < window.since) continue;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time,
      venue_room: room,
      status: ev.isCancelled ? "cancelled" : date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Lowercase and de-pluralize a creative label so the map hits regardless of
 *  template casing or the plural ROH prints when a role has several holders
 *  ("Lighting Designers" → "lighting designer"). */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/s$/, "");
}

/** `production.language` is prose ("Sung in Italian with English surtitles, …").
 *  Pull the sung language (the first one named) to a 2-letter code; null when the
 *  field is absent or names no language we recognize. */
function languageCode(language: string | undefined): RawProduction["language"] {
  if (!language) return null;
  const text = language.toLowerCase();
  for (const [word, code] of Object.entries(SUNG_LANGUAGES)) {
    if (text.includes(word)) return code as RawProduction["language"];
  }
  return null;
}

const SUNG_LANGUAGES: Record<string, string> = {
  italian: "it",
  german: "de",
  french: "fr",
  english: "en",
  russian: "ru",
  czech: "cs",
  spanish: "es",
};

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
