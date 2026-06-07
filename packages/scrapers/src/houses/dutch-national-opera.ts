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
 * Dutch National Opera ("De Nationale Opera", `spielplan-html` strategy) — the
 * leading opera company of the Netherlands, performing at Nationale Opera &
 * Ballet (the "Stopera") in Amsterdam. Tier-1 international (NL/English) house.
 *
 * The site (operaballet.nl, a Drupal build) is SHARED with Dutch National
 * Ballet, so the whole adapter is gated to opera. Two structural facets do that:
 *   - the production URL prefix — opera lives under `/de-nationale-opera/{season}/
 *     {slug}`, ballet under `/het-nationale-ballet/…`, joint galas under
 *     `/nationale-opera-ballet/…`. We only walk the opera prefix (DNO_PATH_RE).
 *   - a `composer` requirement — every production page carries the composer in a
 *     `page-header__subtitle--production` heading ("Giuseppe Verdi (1813 – 1901)").
 *     No composer ⇒ not an opera, dropped. (composerFromText is German-only and
 *     deliberately unused — the label is read straight from this structured field.)
 *
 * Discovery is the XML sitemap (`/sitemap.xml` → 3 paged children), which lists
 * every production URL back to 2018-2019 — far more than the live grid. The
 * sitemap mixes the Dutch canonical pages and their `/en/` mirrors (and the
 * mirrors 404 on production detail), so we keep only the Dutch `/de-nationale-
 * opera/` URLs and parse those.
 *
 * Per-page data:
 *   - Composer — the subtitle heading, `( … )` lifespan stripped.
 *   - Credits + cast — `<p>` blocks of `<br>`-separated "Label  Name" lines.
 *     A line whose label maps via CREATIVE_FUNCTIONS (Dutch labels) is creative
 *     team; the non-credit lines (Muziek/Libretto/orchestra/…) are skipped; the
 *     remaining "Role  Singer" lines are cast. Names carry per-date qualifiers
 *     ("Fabio Luisi, Andrea Sanguineti (25 juni)") and Studio asterisks, cleaned off.
 *   - Performances — live/future pages expose a `data-node-id` whose tickets API
 *     (`/api/1.0/activities/{nodeId}/{any-YYYY-MM}`, one call returns the whole
 *     run) gives each night's date/time/sale-status. Past pages drop the node id
 *     and the API, so we fall back to the JSON-LD `startDate` (the premiere) — the
 *     run is over, so a single dated performance is the faithful minimum.
 *
 * `backfill` additionally appends Wikidata premieres/productions for the deep
 * past the sitemap (2018+) doesn't reach.
 */

const BASE = "https://www.operaballet.nl";
const TICKETS_API = `${BASE}/api/1.0/activities`;
const VENUE = "Nationale Opera & Ballet";

/** Dutch National Opera on Wikidata — the opera COMPANY (Q2281375), not the
 *  Nationale Opera & Ballet building (the venue/foundation). Verified via
 *  wbsearchentities ("Dutch National Opera" and "De Nationale Opera" both resolve
 *  to Q2281375, "Dutch opera company"; P31 = opera company); it carries P272/P4647
 *  production links so the Wikidata backfill is non-empty. */
const WIKIDATA_QID = "Q2281375";

/** Opera production URLs only: `/de-nationale-opera/{season}/{slug}`. Ballet
 *  (`/het-nationale-ballet/…`) and joint events (`/nationale-opera-ballet/…`)
 *  use sibling prefixes and never match — this is the opera-vs-ballet filter. */
const DNO_PATH_RE = /\/de-nationale-opera\/(\d{4}-\d{4})\/([a-z0-9-]+)/g;

/** Dutch creative-team labels → our canonical function slugs. A line whose label
 *  isn't here and isn't a NON_CREDIT label is treated as cast (role → singer);
 *  unmapped creative-ish labels are simply not promoted to creative team. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  "muzikale leiding": "conductor",
  dirigent: "conductor",
  regie: "director",
  "instudering regie": "director",
  decor: "set-designer",
  decorontwerp: "set-designer",
  "decor en kostuums": "set-designer",
  kostuums: "costume-designer",
  kostuumontwerp: "costume-designer",
  video: "video-designer",
  videoontwerp: "video-designer",
  licht: "lighting",
  lichtontwerp: "lighting",
  choreografie: "choreographer",
  koor: "chorus-master",
  "instudering koor": "chorus-master",
  dramaturgie: "dramaturgy",
};

/** Non-credit "Label Name" lines in the same `<p>` blocks — skipped so they don't
 *  leak into the cast. Composer comes from the subtitle, not the "Muziek" line. */
const NON_CREDIT_LABELS = new Set([
  "muziek",
  "libretto",
  "tekst",
  "naar",
  "vertaling",
  "orkest",
  "muzikale begeleiding",
]);

export async function scrapeDutchNationalOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const { season, slug } of await collectOperaPaths(ctx)) {
      const path = `/de-nationale-opera/${season}/${slug}`;
      try {
        const prod = await parseProduction(await fetchHtml(`${BASE}${path}`, ctx), {
          season,
          slug,
          ctx,
          window,
        });
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`dutch-national-opera: production ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("dutch-national-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("dutch-national-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "dutch-national-opera", productions };
}

interface OperaPath {
  season: string;
  slug: string;
}

/** Read the paged XML sitemap and keep the unique opera production paths. The
 *  sitemap index points at `?page=N` children; opera URLs are the `/de-nationale-
 *  opera/{season}/{slug}` locs (the `/en/` mirrors are dropped — they 404 on
 *  detail). */
async function collectOperaPaths(ctx: FetchContext): Promise<OperaPath[]> {
  const index = await fetchHtml(`${BASE}/sitemap.xml`, ctx);
  const childUrls: string[] = [];
  for (const [, u] of index.matchAll(/<loc>([^<]*sitemap\.xml\?page=\d+)<\/loc>/g)) {
    if (u) childUrls.push(u);
  }
  const pages = childUrls.length ? childUrls : [`${BASE}/sitemap.xml`];

  const seen = new Set<string>();
  const out: OperaPath[] = [];
  for (const url of pages) {
    let xml: string;
    try {
      xml = await fetchHtml(url, ctx);
    } catch (err) {
      console.warn(`dutch-national-opera: sitemap ${url} failed:`, err);
      continue;
    }
    for (const [, season, slug] of xml.matchAll(DNO_PATH_RE)) {
      if (!season || !slug) continue;
      const key = `${season}/${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ season, slug });
    }
  }
  return out;
}

async function parseProduction(
  html: string,
  opts: { season: string; slug: string; ctx: FetchContext; window: ScrapeWindow },
): Promise<RawProduction | null> {
  const { season, slug, ctx, window } = opts;

  const composer = parseComposer(html);
  // No composer ⇒ not a staged opera (or a non-production landing page). Opera gate.
  if (!composer) return null;

  const title = parseTitle(html, slug);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);
  const ld = parseEventLd(html);

  const performances = await parsePerformances(html, { ld, ctx, window });
  if (performances.length === 0) return null;

  return {
    source_production_id: `dutch-national-opera/${season}/${slug}`,
    work_title: title,
    composer_name: composer,
    premiere_season: season.replace(/^(\d{4})-\d{2}(\d{2})$/, "$1/$2"),
    detail_url: `${BASE}/de-nationale-opera/${season}/${slug}`,
    image_url: ld?.image ?? null,
    synopsis: ld?.description ? stripHtml(ld.description) : null,
    creative_team,
    cast,
    performances,
  };
}

/** Composer from the `page-header__subtitle--production` heading, e.g.
 *  "Giuseppe Verdi (1813 – 1901)" → "Giuseppe Verdi". Drops any "(… )" lifespan
 *  and trailing "en …" co-composers' years. */
function parseComposer(html: string): string | null {
  const m = html.match(/page-header__subtitle--production[^>]*>([^<]+)</);
  if (!m?.[1]) return null;
  const name = stripHtml(m[1])
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name || null;
}

function parseTitle(html: string, slug: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  const title = h1 ? stripHtml(h1) : "";
  return title || slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Pull creative team + cast from the `<p>` blocks of `<br>`-separated
 *  "Label  Name" lines. Two markups coexist (linked names on live pages, plain
 *  bold-label lines on archived ones) — both reduce to a leading label followed
 *  by one or more names, which `parseCreditLine` handles. */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, block] of html.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    if (!block) continue;
    for (const rawLine of block.split(/<br\s*\/?>/i)) {
      const line = parseCreditLine(rawLine);
      if (!line) continue;
      const { label, names } = line;
      const key = label.toLowerCase();

      if (NON_CREDIT_LABELS.has(key)) continue;

      const fn = CREATIVE_FUNCTIONS[key];
      if (fn) {
        for (const name of names) {
          if (!isPersonName(name)) continue;
          const dedup = `${fn}|${name}`;
          if (seenCreative.has(dedup)) continue;
          seenCreative.add(dedup);
          creative_team.push({ function: fn, name });
        }
        continue;
      }

      // A short character label followed by exactly one person name reads as
      // "Role  Singer". Anything else (free prose, contact/podcast lines, multi-
      // name non-credit lines) is rejected.
      if (names.length === 1 && isRoleLabel(label) && isPersonName(names[0] as string)) {
        const dedup = `${label}|${names[0]}`;
        if (seenCast.has(dedup)) continue;
        seenCast.add(dedup);
        cast.push({ role: label, name: names[0] as string });
      }
    }
  }
  return { creative_team, cast };
}

/** Split one `<br>`-delimited line into its leading label + the bolded/linked
 *  name(s). Names are the `<b>…</b>` (or `<a>…</a>`) spans; the label is the
 *  plain text before the first one. Returns null when there's no name. */
function parseCreditLine(rawLine: string): { label: string; names: string[] } | null {
  const firstTag = rawLine.search(/<(?:a|b)\b/i);
  if (firstTag < 0) return null;

  const label = cleanCredit(rawLine.slice(0, firstTag));
  if (!label) return null;

  const names: string[] = [];
  for (const [, inner] of rawLine.slice(firstTag).matchAll(/<b\b[^>]*>([\s\S]*?)<\/b>/gi)) {
    const name = cleanCredit(inner ?? "");
    if (name && !names.includes(name)) names.push(name);
  }
  // Fallback for plain bold-label markup ("<b>Label </b>Name"): the name is the
  // text after the closing tags rather than inside a <b>.
  if (names.length === 0) {
    const tail = cleanCredit(rawLine.replace(/<[^>]+>/g, " "));
    const stripped = cleanCredit(
      rawLine.replace(/^[\s\S]*?<\/[ab]>/i, "").replace(/<[^>]+>/g, " "),
    );
    const name = stripped || tail.slice(label.length);
    const cleaned = cleanCredit(name);
    if (cleaned) names.push(cleaned);
  }

  return names.length ? { label, names } : null;
}

/** Strip tags/entities and the noise the credit lines carry: per-date casting
 *  qualifiers "(25 juni)", Studio "*" markers, leading "naar/Instudering" glue. */
function cleanCredit(fragment: string): string {
  return stripHtml(decodeEntities(fragment))
    .replace(/\([^)]*\)/g, " ")
    .replace(/[*†]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,;–-]+|[,;–-]+$/g, "")
    .trim();
}

/** Crew-function words: a "Label Name" line carrying one of these is a production
 *  credit (often an unmapped variant — assistant/associate/co-/-coaching), never a
 *  sung character, so it must not fall through to cast. */
const CREW_KEYWORDS =
  /(regie|regiss|leiding|dirigent|koordir|decor|kostuum|licht|video|koor|dramaturg|choreo|beweging|coach|assist|instuder|inleiding|concept|orkest|orgel|bewerking|medewerk|collaborat|associate|co-)/i;

/** A cast "role" label is a short character name, not a sentence, a prose intro,
 *  or a stray crew label. Guards against the descriptive `<p>` lines and unmapped
 *  crew variants being read as cast. */
function isRoleLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= 30 &&
    !/[.!?:]/.test(label) &&
    !CREW_KEYWORDS.test(label) &&
    // Prose intros read as multi-word phrases with lowercase Dutch glue words.
    !/\b(deze|door|befaamde|veelgeprezen|internationaal|regelmatig|veelzijdige)\b/i.test(label)
  );
}

/** A cast name is a person's name: short, no sentence punctuation/digits. Filters
 *  the podcast/contact prose and phone numbers that share the same `<p>` blocks. */
function isPersonName(name: string): boolean {
  return (
    name.length > 1 &&
    name.length <= 60 &&
    /\p{L}/u.test(name) &&
    !/[.!?:]/.test(name) &&
    !/\d/.test(name)
  );
}

interface EventLd {
  name?: string;
  image?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
}

/** The single schema.org `TheaterEvent` JSON-LD node (in an `@graph`). It gives
 *  the date range and media, but only one `startDate` (the premiere) — the per-
 *  night list comes from the tickets API. */
function parseEventLd(html: string): EventLd | null {
  for (const [, raw] of html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw.trim()) as { "@graph"?: unknown[] } & Record<string, unknown>;
      const nodes = Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed];
      for (const node of nodes as Record<string, unknown>[]) {
        if (typeof node["@type"] === "string" && /Event$/.test(node["@type"] as string)) {
          return node as EventLd;
        }
      }
    } catch {
      // Malformed blob — try the next one.
    }
  }
  return null;
}

interface TicketEntry {
  date?: string;
  time?: string;
  status?: string;
}
interface TicketsResponse {
  results?: TicketEntry[];
}

/** Future/live pages expose the tickets API via `data-node-id`; one call returns
 *  every night with date/time/sale-status. Archived pages have neither, so we
 *  fall back to the JSON-LD premiere `startDate`. Honors window.since. */
async function parsePerformances(
  html: string,
  opts: { ld: EventLd | null; ctx: FetchContext; window: ScrapeWindow },
): Promise<RawPerformance[]> {
  const { ld, ctx, window } = opts;
  const today = new Date().toISOString().slice(0, 10);
  const nodeId = html.match(/data-node-id="(\d+)"/)?.[1];
  const range = ldRange(ld);

  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  const add = (date: IsoDate, time: string | null, status: RawPerformance["status"]) => {
    if (window.since && date < window.since) return;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ date, time, venue_room: VENUE, status });
  };

  if (nodeId && range) {
    try {
      const data = await fetchJson<TicketsResponse>(
        `${TICKETS_API}/${nodeId}/${range.start.slice(0, 7)}`,
        ctx,
      );
      for (const entry of data.results ?? []) {
        const date = resolveDate(entry.date, range);
        if (!date) continue;
        add(date, parseTime(entry.time), ticketStatus(entry.status, date, today));
      }
    } catch (err) {
      console.warn(`dutch-national-opera: tickets API node ${nodeId} failed:`, err);
    }
  }

  // No live nights (past production, or API miss): seed the premiere from JSON-LD.
  if (out.length === 0 && range) {
    add(range.start, parseTime(ld?.startDate), range.start < today ? "past" : "scheduled");
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

interface DateRange {
  start: IsoDate;
  end: IsoDate;
}

function ldRange(ld: EventLd | null): DateRange | null {
  const start = ld?.startDate?.slice(0, 10);
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const end = ld?.endDate?.slice(0, 10);
  return {
    start: start as IsoDate,
    end: (end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : start) as IsoDate,
  };
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** The tickets API prints "Sunday 07 June" with no year. The JSON-LD range spans
 *  the run, so resolve the year by picking whichever candidate (range.start year
 *  or the next) yields a date inside the run — handles Dec→Jan season crossovers. */
function resolveDate(label: string | undefined, range: DateRange): IsoDate | null {
  const m = label?.match(/(\d{1,2})\s+([A-Za-z]+)/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[m[2]?.toLowerCase() ?? ""];
  if (!month || !day) return null;

  const startYear = Number(range.start.slice(0, 4));
  for (const year of [startYear, startYear + 1]) {
    const iso = `${year}-${pad(month)}-${pad(day)}` as IsoDate;
    if (iso >= range.start && iso <= range.end) return iso;
  }
  // Outside the advertised range (range is a hint, not a hard bound): fall back to
  // the year that keeps the date on/after the run's start.
  const iso = `${startYear}-${pad(month)}-${pad(day)}` as IsoDate;
  return iso >= range.start ? iso : (`${startYear + 1}-${pad(month)}-${pad(day)}` as IsoDate);
}

function parseTime(value: string | undefined): string | null {
  const m = value?.match(/(\d{1,2}):(\d{2})/);
  return m ? `${pad(Number(m[1]))}:${m[2]}` : null;
}

function ticketStatus(
  status: string | undefined,
  date: IsoDate,
  today: string,
): RawPerformance["status"] {
  if (date < today) return "past";
  switch (status) {
    case "sold-out":
      return "sold_out";
    case "last-tickets":
      return "few_left";
    default:
      return "scheduled";
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
