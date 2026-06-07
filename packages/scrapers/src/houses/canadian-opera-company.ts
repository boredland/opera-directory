import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Canadian Opera Company (`spielplan-html` strategy) — Canada's largest opera
 * company, in Toronto (Canada/English), staging a ~Sep–May season at the Four
 * Seasons Centre for the Performing Arts. The live scrape walks the on-site
 * season pages; `backfill` appends Wikidata for the deep past (the on-site
 * archive only keeps the current handful of seasons — older `/tickets/{season}`
 * pages redirect to a contentless stub).
 *
 * The site is SSR HTML with no Event JSON-LD and no `__NEXT_DATA__`. Two sources
 * combine per production:
 *   - the `/tickets/{season}/{slug}` detail page carries everything but the
 *     per-night dates: composer in the `composer-panel__title` ("Composed By
 *     {Name}" — an ENGLISH structured field, NOT the German composerFromText),
 *     cast in the "Cast" `people-panel` and creative team in the "Creative"
 *     `people-panel` (each a `person__name` + `person__role`; the creative
 *     `person__role` is an ENGLISH function label mapped in-adapter via
 *     CREATIVE_FUNCTIONS). The opening/closing ISO timestamps ride along as
 *     `<meta class="swiftype" name="start_date"/"end_date">`.
 *   - the JSON events feed (`{proxyBase}/events/{n}/40/Live`, the same endpoint
 *     the page's Vue `performance-widget` hydrates from) lists each *future*
 *     production's exact dated nights in `Performances[]`. Productions still in
 *     this feed get one RawPerformance per night; productions that have rolled
 *     out of it (past) fall back to a single opening-night performance from the
 *     detail page's `start_date` meta.
 *
 * Opera filter: REQUIRE a composer. Galas, concerts, the Centre Stage
 * competition and the Ensemble Studio showcases publish no `composer-panel`
 * (or no detail page) and fail this test.
 */

const BASE = "https://www.coc.ca";
/** The Vue `performance-widget`'s data feed (AppConfig.proxyBaseUrl + the
 *  `/events/{count}/40/{stage}` path baked into the site bundle). Returns only
 *  the future season — productions already played drop out. */
const EVENTS_FEED = "https://d1ndd0kfyiplr2.cloudfront.net/Prod/events/100/40/Live";
const VENUE = "Four Seasons Centre for the Performing Arts";

/** Canadian Opera Company on Wikidata — the opera COMPANY (Q2915268), not its
 *  Ensemble Studio program (Q128652038) or the COC Theatre building
 *  (Q127296058). Verified via wbsearchentities: Q2915268 = "Canadian Opera
 *  Company", description "opera company based in Toronto, Ontario". */
const WIKIDATA_QID = "Q2915268";

/** English creative-team labels (the "Creative" panel's `person__role`) → our
 *  canonical function slugs. Revival/associate/assistant variants fold onto the
 *  principal function; an unmapped label (e.g. Wig & Makeup, Fight Director) is
 *  dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "original director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "set & costume designer": "set-designer",
  "set and costume designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "revival lighting designer": "lighting",
  "original lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  "projection & video designer": "projection-designer",
  "projection and video designer": "projection-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

interface FeedPerformance {
  PerformanceDate?: string;
  IsOnSale?: boolean;
  ProductionType?: { ID?: number; Title?: string } | null;
}
interface FeedEvent {
  Link?: string;
  Title?: string;
  Suffix?: string | null;
  Performances?: FeedPerformance[];
}

export async function scrapeCanadianOperaCompany(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let feed = new Map<string, RawPerformance[]>();
  try {
    feed = await fetchFeedNights(ctx, window);
  } catch (err) {
    console.warn("canadian-opera-company: events feed failed:", err);
  }

  try {
    for (const path of await collectProductionPaths(ctx, window)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}${path}`, ctx), path, feed, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`canadian-opera-company: production ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("canadian-opera-company: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("canadian-opera-company: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "canadian-opera-company", productions };
}

/** Season slugs are `{startYY}{endYY}-season` (2025/26 → `2526-season`). The
 *  on-site archive only goes back ~one season; incremental covers the current +
 *  next season, backfill reaches back a few more (older pages redirect to a
 *  contentless stub and yield nothing — Wikidata carries the deep past). */
function seasonSlugs(window: ScrapeWindow): string[] {
  const now = new Date();
  // A COC season opens in autumn; before August the "current" season started the
  // previous calendar year.
  const startYear = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const seasonsBack = window.mode === "backfill" ? 4 : 0;
  const slugs: string[] = [];
  for (let offset = 1; offset >= -seasonsBack; offset--) {
    const start = startYear + offset;
    slugs.push(
      `${String(start % 100).padStart(2, "0")}${String((start + 1) % 100).padStart(2, "0")}-season`,
    );
  }
  return slugs;
}

/** Walk the season index pages and collect every `/tickets/{season}/{slug}`
 *  production path (student-performance / full-credits / package sub-pages are
 *  skipped; non-opera items survive here and are dropped later by the composer
 *  gate). */
async function collectProductionPaths(ctx: FetchContext, window: ScrapeWindow): Promise<string[]> {
  const paths = new Set<string>();
  for (const season of seasonSlugs(window)) {
    try {
      const html = await fetchHtml(`${BASE}/tickets/${season}`, ctx);
      for (const [, slug] of html.matchAll(
        new RegExp(`href="(?:${BASE})?/tickets/${season}/([a-z0-9-]+)"`, "g"),
      )) {
        if (!slug || /student-performance|full-credits/.test(slug)) continue;
        paths.add(`/tickets/${season}/${slug}`);
      }
    } catch (err) {
      console.warn(`canadian-opera-company: season ${season} index failed:`, err);
    }
  }
  return [...paths];
}

function parseProduction(
  html: string,
  path: string,
  feed: Map<string, RawPerformance[]>,
  window: ScrapeWindow,
): RawProduction | null {
  const composer = parseComposer(html);
  // No "Composed By" panel ⇒ a gala / concert / competition / showcase, not
  // staged opera. This is the opera filter.
  if (!composer) return null;

  const performances = performancesFor(path, html, feed, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html) || slugToTitle(path);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `canadian-opera-company${path}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(html),
    detail_url: `${BASE}${path}`,
    creative_team,
    cast,
    performances,
  };
}

/** "Composed By {Name}" in the `composer-panel__title` (the prefix sits in a
 *  nested `composer-panel__prefix` span; strip it). */
function parseComposer(html: string): string | null {
  const block = html.match(/<h2 class="composer-panel__title">([\s\S]*?)<\/h2>/)?.[1];
  if (!block) return null;
  const name = stripHtml(block.replace(/<span class="composer-panel__prefix">[\s\S]*?<\/span>/, ""))
    .replace(/^Composed By\s*/i, "")
    .trim();
  return name && /[A-Za-z]/.test(name) ? name : null;
}

function parseTitle(html: string): string | null {
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (og) {
    const title = decodeEntities(og)
      .replace(/\s*[-–|]\s*Canadian Opera Company\s*$/i, "")
      .trim();
    if (title) return title;
  }
  return null;
}

/**
 * Cast and creative live in two `people-panel` sections discriminated by their
 * `people-panel__title` ("Cast" vs "Creative"); within each, a person is a
 * `person__name` + `person__role`. Cast keeps the verbatim character role;
 * creative maps the function label and drops the unmapped.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCast = new Set<string>();
  const seenCreative = new Set<string>();

  for (const [, title, body] of html.matchAll(
    /<h2 class="people-panel__title">([^<]*)<\/h2>([\s\S]*?)(?=<section|<footer|$)/g,
  )) {
    const isCreative = /creative/i.test(title ?? "");
    const isCast = /cast/i.test(title ?? "");
    if (!isCreative && !isCast) continue;

    for (const [, rawName, rawRole] of (body ?? "").matchAll(
      /<h3 class="person__name">([\s\S]*?)<\/h3>[\s\S]*?<div class="person__role">([\s\S]*?)<\/div>/g,
    )) {
      const name = stripHtml(rawName ?? "");
      const role = stripHtml(rawRole ?? "");
      if (!name) continue;

      if (isCreative) {
        const fn = CREATIVE_FUNCTIONS[role.toLowerCase()];
        if (!fn) continue;
        const key = `${fn}|${name}`;
        if (seenCreative.has(key)) continue;
        seenCreative.add(key);
        creative_team.push({ function: fn, name });
      } else {
        if (!role) continue;
        const key = `${role}|${name}`;
        if (seenCast.has(key)) continue;
        seenCast.add(key);
        cast.push({ role, name });
      }
    }
  }
  return { creative_team, cast };
}

/** Exact dated nights from the events feed when the production is still in it;
 *  otherwise the single opening-night anchor from the detail page's
 *  `start_date` meta (past productions have left the feed). Honors window.since. */
function performancesFor(
  path: string,
  html: string,
  feed: Map<string, RawPerformance[]>,
  window: ScrapeWindow,
): RawPerformance[] {
  const since = window.since;
  const nights = feed.get(path);
  if (nights?.length) {
    return since ? nights.filter((p) => p.date >= since) : nights;
  }

  const start = html.match(/<meta class="swiftype" name="start_date"[^>]*content="([^"]+)"/)?.[1];
  const m = (start ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  if (!m) return [];
  const date = m[1] as IsoDate;
  if (window.since && date < window.since) return [];
  const today = new Date().toISOString().slice(0, 10);
  return [
    { date, time: m[2] ?? null, venue_room: VENUE, status: date < today ? "past" : "scheduled" },
  ];
}

/** Index the events feed by production path → its dated nights. The feed lists
 *  future productions only; galas/competitions appear too but are filtered out
 *  downstream by the composer gate, so we index everything here. */
async function fetchFeedNights(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<Map<string, RawPerformance[]>> {
  const events = await fetchJson<FeedEvent[]>(EVENTS_FEED, ctx);
  const today = new Date().toISOString().slice(0, 10);
  const byPath = new Map<string, RawPerformance[]>();

  for (const ev of events) {
    const path = (ev.Link ?? "").replace(/[#?].*$/, "").replace(/\/$/, "");
    if (!path.startsWith("/tickets/")) continue;
    const out: RawPerformance[] = [];
    const seen = new Set<string>();
    for (const p of ev.Performances ?? []) {
      const m = (p.PerformanceDate ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
      if (!m) continue;
      const date = m[1] as IsoDate;
      const time = m[2] ?? null;
      if (window.since && date < window.since) continue;
      const key = `${date}|${time ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date, time, venue_room: VENUE, status: date < today ? "past" : "scheduled" });
    }
    if (out.length) {
      byPath.set(
        path,
        out.sort(
          (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
        ),
      );
    }
  }
  return byPath;
}

/** "Sung in Italian with English and French SURTITLES" → "it". */
function languageCode(html: string): RawProduction["language"] {
  const first = html.match(/Sung in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
  if (!first) return null;
  return (
    ({
      italian: "it",
      english: "en",
      german: "de",
      french: "fr",
      russian: "ru",
      czech: "cs",
      spanish: "es",
    }[first] as RawProduction["language"]) ?? null
  );
}

function slugToTitle(path: string): string {
  return (path.split("/").pop() ?? "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
