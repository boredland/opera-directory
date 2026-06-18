import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, proxyFetch, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";

/**
 * Metropolitan Opera — two sources, one per leg of the timeline:
 *
 *   - Announced future (both modes): the live current + next season off
 *     metopera.org (see "Live season" below).
 *   - Deep archive (backfill only): the MetOpera Database, the gold-standard
 *     public DB back to 1883 (see "Archive" below).
 *
 * Archive. archives.metopera.org is performance-centric: `search.jsp?date_start=
 * &date_end=` returns every performance in a window (one response per season, no
 * paging), and `record.jsp?dockey=` carries the full cast + creative + composer
 * for one performance. We fold that into our production-centric model cheaply:
 *   1. Walk season by season (cheap list): CID, work title, date, venue, and the
 *      "New Production" flag that marks the start of a staging.
 *   2. Group performances into productions — a New Production (or a work's first
 *      appearance in the walked range) opens one; later performances attach.
 *   3. Fetch record.jsp ONCE per production (its premiere) for cast/creative/
 *      composer — they're production-level, so one fetch covers the whole run.
 * It's deep history, so only the backfill run walks it (incremental would re-fetch
 * decades nightly); bound a full import with `--since` (e.g. `--since=1990-01-01`).
 */

const SEARCH_URL = "https://archives.metopera.org/MetOperaSearch/search.jsp";
const RECORD_URL = "https://archives.metopera.org/MetOperaSearch/record.jsp";
const FIRST_SEASON = 1883;

export async function scrapeMetropolitanOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  // Announced future — always emit it, regardless of window/mode.
  try {
    productions.push(...(await scrapeLiveSeasons(ctx)));
  } catch (err) {
    console.warn("metropolitan-opera: live season scrape failed:", err);
  }

  // Deep archive — backfill only; an incremental run must not re-walk it.
  if (window.mode === "backfill") {
    const rows = await walkSeasons(ctx, window);
    const archived = groupIntoProductions(rows, window);
    for (const prod of archived) {
      try {
        await enrichFromRecord(ctx, prod);
      } catch (err) {
        console.warn(`metropolitan-opera: record ${prod.source_production_id} failed:`, err);
      }
    }
    productions.push(...archived);
  }

  return { house_slug: "metropolitan-opera", productions };
}

// ── Live current + next season (metopera.org) ────────────────────────────────
//
// The archive only holds performed nights; the announced future lives on
// metopera.org. Each season has an index grid (/season/{slug}/) linking its
// productions, and every production page carries one hidden JSON blob
// (`#hdnCastMembers`) seeding an Angular cast widget: the conductor + sung cast
// and, per person, the exact local-time (ET) dates they perform. So one fetch per
// production yields title, composer, cast, conductor and the full date list.
//
// The grid also lists concerts and recitals (a Mahler symphony, a song recital).
// We keep only stagings, detected by the presence of a named character role —
// concerts bill their singers as "Soloist", or list none at all.

const LIVE_BASE = "https://www.metopera.org";

interface LiveCastMember {
  name?: string;
  bioPageLink?: string;
  numberlessRole?: string;
  role?: string;
  performanceDates?: string[];
}

async function scrapeLiveSeasons(ctx: FetchContext): Promise<RawProduction[]> {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawProduction[] = [];

  for (const season of currentSeasonSlugs()) {
    let slugs: string[];
    try {
      slugs = parseSeasonIndex(await fetchHtml(`${LIVE_BASE}/season/${season}/`, ctx), season);
    } catch (err) {
      console.warn(`metropolitan-opera: season index ${season} failed:`, err);
      continue;
    }
    let kept = 0;
    for (const slug of slugs) {
      try {
        const html = await fetchHtml(`${LIVE_BASE}/season/${season}/${slug}/`, ctx);
        const prod = parseLiveProduction(html, season, slug, today);
        if (prod) {
          out.push(prod);
          kept++;
        }
      } catch (err) {
        console.warn(`metropolitan-opera: live ${season}/${slug} failed:`, err);
      }
    }
    console.log(
      `metropolitan-opera: live ${season} → ${kept}/${slugs.length} grid items are operas`,
    );
  }
  return out;
}

/** The current season plus the next: US seasons start in September, so before
 *  then we're still in the {Y-1}/{Y} season. Slug form "2025-26-season". */
function currentSeasonSlugs(): string[] {
  const now = new Date();
  const start = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const slug = (s: number) => `${s}-${String((s + 1) % 100).padStart(2, "0")}-season`;
  return [slug(start), slug(start + 1)];
}

/** Production cards on the season index link to /season/{slug}/{prod}/ — one path
 *  segment past the season root (so the root itself, ABT and special-presentation
 *  paths, which sit under different segments, are excluded). */
function parseSeasonIndex(html: string, season: string): string[] {
  const slugs = new Set<string>();
  const re = new RegExp(`href="/season/${escapeRegex(season)}/([^"/]+)/"`, "g");
  for (const m of html.matchAll(re)) if (m[1]) slugs.add(m[1]);
  return [...slugs];
}

function parseLiveProduction(
  html: string,
  season: string,
  slug: string,
  today: string,
): RawProduction | null {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seenCast = new Set<string>();
  const seenCreative = new Set<string>();
  const dates = new Set<string>();

  for (const m of parseCastMembers(html)) {
    const name = stripHtml(m.name ?? "");
    const role = (m.numberlessRole ?? m.role ?? "").trim();
    if (!name) continue;
    for (const d of m.performanceDates ?? []) dates.add(d);

    const fn = LIVE_CREATIVE[role.toLowerCase()];
    if (fn) {
      const key = `${fn}|${name}`;
      if (!seenCreative.has(key)) {
        seenCreative.add(key);
        creative.push({ function: fn, name });
      }
    } else if (role && role !== "Soloist") {
      const key = `${role}|${name}`;
      if (!seenCast.has(key)) {
        seenCast.add(key);
        cast.push({ role, name });
      }
    }
  }

  // No named character role ⇒ a concert/recital sharing the season grid, not a
  // staging. Skip it.
  if (cast.length === 0) return null;

  const performances: RawPerformance[] = [...dates]
    .map((d): RawPerformance | null => {
      const [date, time] = d.split("T");
      if (!date) return null;
      return {
        date: date as IsoDate,
        time: time ? time.slice(0, 5) : null,
        status: date < today ? "past" : "scheduled",
      };
    })
    .filter((p): p is RawPerformance => p !== null)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));

  const title = stripHtml(html.match(/pdp-hero-box-text">([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const composer = stripHtml(html.match(/pdp-hero-box-composer">([^<]*)</)?.[1] ?? "") || null;
  if (!title || performances.length === 0) return null;

  return {
    source_production_id: `met-live/${season}/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${LIVE_BASE}/season/${season}/${slug}/`,
    creative_team: creative,
    cast,
    performances,
  };
}

/** The cast widget is seeded from a single hidden input whose HTML-encoded value
 *  is the JSON array; the value attribute precedes the id in the tag. */
function parseCastMembers(html: string): LiveCastMember[] {
  const idIdx = html.indexOf('id="hdnCastMembers"');
  if (idIdx < 0) return [];
  const start = html.lastIndexOf("<input", idIdx);
  const raw =
    start < 0 ? null : (html.slice(start, idIdx).match(/value="([\s\S]*?)"/)?.[1] ?? null);
  if (!raw) return [];
  try {
    return JSON.parse(decodeEntities(raw)) as LiveCastMember[];
  } catch {
    return [];
  }
}

/** The only production-team function the live blob carries (director/designers
 *  aren't structured on the page); everything else in it is sung cast. */
const LIVE_CREATIVE: Record<string, string> = {
  conductor: "conductor",
};

// ── Season walk + result-list parsing ───────────────────────────────────────

interface PerfRow {
  cid: string;
  dockey: string;
  workTitle: string;
  date: IsoDate;
  venue: string | null;
  newProduction: boolean;
}

async function walkSeasons(ctx: FetchContext, window: ScrapeWindow): Promise<PerfRow[]> {
  const startYear = window.since ? Number.parseInt(window.since.slice(0, 4), 10) : FIRST_SEASON;
  const endYear = new Date().getUTCFullYear();
  const rows: PerfRow[] = [];

  for (let year = startYear; year <= endYear; year++) {
    const body = new URLSearchParams({
      sort: "PDATE",
      name: "",
      titles: "",
      terms: "",
      important_note: "",
      date_start: `09/01/${year}`,
      date_end: `08/31/${year + 1}`,
      submit: "Search",
    });
    try {
      const html = await postForm(SEARCH_URL, body, ctx);
      const season = parseResultRows(html);
      rows.push(...season);
      console.log(`metropolitan-opera: ${year}/${year + 1} → ${season.length} performances`);
    } catch (err) {
      console.warn(`metropolitan-opera: season ${year} failed:`, err);
    }
  }
  return rows;
}

function parseResultRows(html: string): PerfRow[] {
  const rows: PerfRow[] = [];
  // Each result block runs from one "[Met Performance]" marker to the next.
  const blocks = html.split("[Met Performance]").slice(1);
  for (const block of blocks) {
    const cid = block.match(/CID\s*:\s*(\d+)/)?.[1];
    const dockey = block.match(/record\.jsp\?dockey=(\d+)/)?.[1];
    if (!cid || !dockey) continue;

    const titleRaw = block.match(/record\.jsp\?dockey=\d+">([\s\S]*?)<br/)?.[1];
    const workTitle = titleRaw
      ? stripHtml(titleRaw)
          .replace(/\s*\(\d+\)\s*$/, "")
          .trim()
      : "";
    if (!workTitle) continue;

    const dateText = block.match(/;\s*[A-Za-z]+,\s*([A-Z][a-z]+ \d{1,2}, \d{4})/)?.[1];
    const date = dateText ? parseUsDate(dateText) : null;
    if (!date) continue;

    const venue =
      block.match(/<br>\s*([^<;]+?);\s*[A-Za-z]+,\s*[A-Z][a-z]+ \d/)?.[1]?.trim() ?? null;
    rows.push({
      cid,
      dockey,
      workTitle,
      date,
      venue,
      newProduction: /New Production/.test(block),
    });
  }
  return rows;
}

// ── Group performances into productions ─────────────────────────────────────

function groupIntoProductions(rows: PerfRow[], window: ScrapeWindow): RawProduction[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const current = new Map<string, RawProduction>(); // workTitle → open production
  const out: RawProduction[] = [];

  for (const row of sorted) {
    if (window.since && row.date < window.since) continue;
    let prod = current.get(row.workTitle);
    if (!prod || row.newProduction) {
      prod = {
        source_production_id: `met-cid-${row.cid}`,
        work_title: row.workTitle,
        premiere_date: row.date,
        premiere_season: seasonOf(row.date),
        // A New-Production marker is the staging's real premiere; a work that just
        // appears mid-window (no marker) is a revival whose true premiere we can't see.
        is_revival: !row.newProduction,
        detail_url: `${RECORD_URL}?dockey=${row.dockey}`,
        performances: [],
      };
      current.set(row.workTitle, prod);
      out.push(prod);
    }
    prod.performances.push({ date: row.date, venue_room: row.venue, status: "past" });
  }
  return out;
}

// ── Per-production detail (record.jsp) ───────────────────────────────────────

async function enrichFromRecord(ctx: FetchContext, prod: RawProduction): Promise<void> {
  const dockey = prod.detail_url?.match(/dockey=(\d+)/)?.[1];
  if (!dockey) return;
  const html = await fetchHtml(`${RECORD_URL}?dockey=${dockey}`, ctx);

  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  // Sung roles are listed first; the production team begins at the first known
  // function/staff label (Conductor) and runs to the end. So flip at that
  // boundary — never treat a post-boundary unknown label as a sung role.
  let inCast = true;
  for (const m of html.matchAll(
    /<dl><dt><span>([^<]*)<\/span><\/dt>\s*<dd>([\s\S]*?)<\/dd><\/dl>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    const low = label.toLowerCase();
    if (inCast && (low in CREATIVE_FUNCTIONS || STAFF_SKIP.has(low))) inCast = false;

    const name = parseCreditName(m[2] ?? "");
    if (!label || !name) continue;
    if (inCast) cast.push({ role: label, name });
    else if (CREATIVE_FUNCTIONS[low]) creative.push({ function: CREATIVE_FUNCTIONS[low], name });
  }
  prod.creative_team = creative;
  prod.cast = cast;
  prod.composer_name = parseComposer(html, prod.work_title);
}

/**
 * A dedicated comment holds "<b>Title (n)</b><br>Composer | Librettist<br>…".
 * Isolate each comment, strip its tags, then read the composer between the
 * "Title (n)" and the first "|". Fall back to the <dt>Composer</dt> field.
 */
function parseComposer(html: string, workTitle: string): string | null {
  const re = new RegExp(`${escapeRegex(workTitle)}\\s*\\(\\d+\\)\\s*([^|]+?)\\s*\\|`);
  for (const m of html.matchAll(/<!--((?:(?!-->)[\s\S])*?)-->/g)) {
    const composer = stripHtml(m[1] ?? "")
      .match(re)?.[1]
      ?.trim();
    if (composer) return composer;
  }
  const dt = html.match(/<dt><span>Composer<\/span><\/dt>\s*<dd>([\s\S]*?)<\/dd>/)?.[1];
  return dt ? parseCreditName(dt) || null : null;
}

/** A <dd> is "<a>Name</a> [Debut]" or bare text; take the name, drop the debut tag. */
function parseCreditName(dd: string): string {
  const linked = dd.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1];
  return stripHtml(linked ?? dd)
    .replace(/\s*\[Debut\]\s*/g, "")
    .trim();
}

const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  director: "director",
  production: "director",
  "stage director": "director",
  "revival stage director": "director",
  "set designer": "set-designer",
  "set and projection designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "co-projection designer": "projection-designer",
  "video designer": "video-designer",
  "sound designer": "sound-designer",
  choreographer: "choreographer",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
};

/** Production-team labels we don't model — they only mark the cast/team boundary. */
const STAFF_SKIP = new Set([
  "composer",
  "general manager",
  "general manager (director)",
  "assistant conductor",
  "musical preparation",
  "prompter",
  "continuo",
  "fortepiano",
  "stage band conductor",
  "translation",
  "english translation",
]);

// ── helpers ─────────────────────────────────────────────────────────────────

const US_MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/** "October 22, 1883" → "1883-10-22". */
function parseUsDate(text: string): IsoDate | null {
  const m = text.match(/([A-Z][a-z]+) (\d{1,2}), (\d{4})/);
  const month = m ? US_MONTHS[m[1]?.toLowerCase() ?? ""] : undefined;
  if (!m || !month) return null;
  return isoFromParts(m[3] ?? "", month, m[2] ?? "");
}

/** US opera seasons run Sep–Aug: an Oct 1883 date belongs to "1883/84". */
function seasonOf(date: IsoDate): string {
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  const start = month >= 9 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function postForm(url: string, body: URLSearchParams, ctx: FetchContext): Promise<string> {
  const res = await proxyFetch(url, ctx.proxy, {
    method: "POST",
    headers: {
      "User-Agent": ctx.userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} → ${res.status}`);
  return res.text();
}
