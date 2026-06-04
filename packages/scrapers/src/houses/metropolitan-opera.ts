import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, proxyFetch, stripHtml } from "../fetch";
import type { HouseScrapeResult, RawCredit, RawProduction, ScrapeWindow } from "../types";

/**
 * Metropolitan Opera — archive importer (gold-standard public DB, back to 1883).
 *
 * The MetOpera Database (archives.metopera.org) is performance-centric: a JSP app
 * where `search.jsp?date_start=&date_end=` returns every performance in a window
 * (one response per season, no paging), and `record.jsp?dockey=` carries the full
 * cast + creative team + composer for one performance.
 *
 * We turn that into our production-centric model cheaply:
 *   1. Walk season by season (cheap list): CID, work title, date, venue, and the
 *      "New Production" flag that marks the start of a staging.
 *   2. Group performances into productions — a New Production (or a work's first
 *      appearance in the walked range) opens one; later performances attach.
 *   3. Fetch record.jsp ONCE per production (its premiere) for cast/creative/
 *      composer — they're production-level, so one fetch covers the whole run.
 *
 * Backfill-only: this is deep history. The Met's *current* season is better taken
 * live (jsonld-event, TODO); an incremental run here is a no-op. A full 1883→today
 * import is a long one-off — bound it with `--since` (e.g. `--backfill --since=1990-01-01`).
 */

const SEARCH_URL = "https://archives.metopera.org/MetOperaSearch/search.jsp";
const RECORD_URL = "https://archives.metopera.org/MetOperaSearch/record.jsp";
const FIRST_SEASON = 1883;

export async function scrapeMetropolitanOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  if (window.mode !== "backfill") {
    console.warn("metropolitan-opera: archive is backfill-only; incremental run is a no-op");
    return { house_slug: "metropolitan-opera", productions: [] };
  }

  const rows = await walkSeasons(ctx, window);
  const productions = groupIntoProductions(rows, window);
  for (const prod of productions) {
    try {
      await enrichFromRecord(ctx, prod);
    } catch (err) {
      console.warn(`metropolitan-opera: record ${prod.source_production_id} failed:`, err);
    }
  }
  return { house_slug: "metropolitan-opera", productions };
}

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
  return `${m[3]}-${month}-${(m[2] ?? "").padStart(2, "0")}` as IsoDate;
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
