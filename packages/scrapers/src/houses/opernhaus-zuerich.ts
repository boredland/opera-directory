import type { IsoDate } from "@opera-directory/schema";
import {
  decodeEntities,
  extractEventJsonLd,
  type FetchContext,
  fetchHtml,
  stripHtml,
} from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Opernhaus Zürich / Zürich Opera House (`spielplan-html` strategy).
 *
 * A top German-language house (Zürich, Switzerland) presenting opera, Ballett
 * Zürich and concerts side by side. The site is German-language SSR HTML on a
 * ProcessWire CMS — no public JSON API — but it emits schema.org Event JSON-LD
 * for the future programme and exposes clean per-genre archive indexes for the
 * past, so this reads the rendered markup directly (no headless render needed).
 *
 * Discovery is two legs:
 *   - FUTURE (always): the calendar `/spielplan/kalendarium/` paginates forward
 *     `pageN` (~24 pages, two weeks each). Each page carries one JSON-LD Event
 *     per performance night with startDate, location.name (the room) and a
 *     `description` whose first line names the composer. Events are grouped by
 *     their detail-URL slug into productions.
 *   - PAST (backfill): the archive ships per-season, per-GENRE indexes
 *     `/spielplan/archiv/oper-{SS}/` (e.g. `oper-2425` = 2024/25) that already
 *     pre-filter to opera and link the same `/kalendarium/{slug}/{season}/`
 *     detail pages. Walked backward season by season, bounded by `window.since`.
 *
 * OPERA GATE — the calendar and house mix opera, ballet, concerts, galas and
 * guided tours, so each production is gated on its detail page: the
 * `<meta name="description">` must begin "Oper von …" (ballet reads "Ballett
 * von …", tours/workshops have an empty meta). The composer is taken from that
 * line (via composerFromText, which trims trailing life-dates), which is also
 * the REQUIRE-a-composer gate. That drops Ballett Zürich, Konzerte, Liederabende
 * and Kinder/Führung formats.
 *
 * Per detail page:
 *   - composer: `<meta name="description" content="Oper von …">`.
 *   - title: `<h1>`.
 *   - performances: the page's JSON-LD Events (future, one per night, dated with
 *     room + status). Past productions carry no Events, only a printed run range
 *     ("Von {date} bis {date}" / "Am {date}"); its bounds are emitted as
 *     performances so an archived production is still anchored in its season.
 *   - creative team: `leading-team` blocks (`<div class="label">Regie:</div>` +
 *     `<a class="url">Name</a>`), mapped via normalizeGermanCredit.
 *   - cast: `bio-legend` rows (`<span class="function">Role</span>` +
 *     `<span class="name">Name</span>`), kept verbatim as sung roles.
 */

const BASE = "https://www.opernhaus.ch";

/** Zürich Opera House on Wikidata — Q670406 ("Zürich Opera House", P31 = opera
 *  house / theatre building). Verified via wbsearchentities AND by SPARQL: it
 *  carries 15 labeled premieres via P4647/P272, whereas the separate "theatre
 *  company" record Q113486569 carries 1371 production items that are ALL
 *  unlabeled bare-QIDs (no work title, so the wikidata strategy skips them) — so
 *  the building QID is the one with usable backfill. */
const WIKIDATA_QID = "Q670406";

const MONTHS: Record<string, number> = {
  januar: 1,
  februar: 2,
  märz: 3,
  maerz: 3,
  april: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  dezember: 12,
};

/** Forward calendar pages to walk for the announced future (the pager tops out
 *  around 24; the cap is generous and the walk stops early on an empty page). */
const MAX_FUTURE_PAGES = 30;

/** Earliest archive season the house publishes an `oper-{SS}` index for: 2012/13. */
const EARLIEST_ARCHIVE_YEAR = 2012;

export async function scrapeOpernhausZuerich(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const detailUrls = await collectDetailUrls(ctx, window);
    for (const url of detailUrls) {
      try {
        const html = await fetchHtml(url, ctx);
        const prod = parseProduction(html, url, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`opernhaus-zuerich: detail ${url} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("opernhaus-zuerich: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opernhaus-zuerich: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "opernhaus-zuerich", productions };
}

/**
 * Collect unique production detail URLs. Incremental: walk the forward calendar
 * pages (the full announced future). Backfill: walk the opera-only archive
 * season indexes backward, bounded by `window.since`.
 */
async function collectDetailUrls(ctx: FetchContext, window: ScrapeWindow): Promise<string[]> {
  const urls = new Set<string>();

  if (window.mode === "backfill") {
    await collectArchiveUrls(ctx, window.since, urls);
  }

  // The future leg ignores the window — always emit the complete announced future.
  await collectFutureUrls(ctx, urls);

  return [...urls];
}

/** Walk `/spielplan/kalendarium/[pageN]` forward until a page yields no new
 *  detail links (end of the announced season) or the cap is hit. */
async function collectFutureUrls(ctx: FetchContext, urls: Set<string>): Promise<void> {
  for (let page = 1; page <= MAX_FUTURE_PAGES; page++) {
    const indexUrl =
      page === 1 ? `${BASE}/spielplan/kalendarium/` : `${BASE}/spielplan/kalendarium/page${page}`;
    let html: string;
    try {
      html = await fetchHtml(indexUrl, ctx);
    } catch (err) {
      console.warn(`opernhaus-zuerich: calendar page ${page} failed:`, err);
      break;
    }
    const before = urls.size;
    addDetailUrls(html, urls);
    if (urls.size === before) break;
  }
}

/** Walk `/spielplan/archiv/oper-{SS}/` from the current season back to `since`
 *  (or the earliest published season). Each index is already opera-only. */
async function collectArchiveUrls(
  ctx: FetchContext,
  since: IsoDate | null,
  urls: Set<string>,
): Promise<void> {
  const sinceYear = since ? Number.parseInt(since.slice(0, 4), 10) : EARLIEST_ARCHIVE_YEAR;
  const floorYear = Math.max(sinceYear - 1, EARLIEST_ARCHIVE_YEAR);
  const currentSeasonStart = currentSeasonStartYear();

  for (let start = currentSeasonStart; start >= floorYear; start--) {
    const code = `${String(start % 100).padStart(2, "0")}${String((start + 1) % 100).padStart(2, "0")}`;
    try {
      const html = await fetchHtml(`${BASE}/spielplan/archiv/oper-${code}/`, ctx);
      addDetailUrls(html, urls);
    } catch (err) {
      if (!/→ 404$/.test(String(err))) {
        console.warn(`opernhaus-zuerich: archive oper-${code} failed:`, err);
      }
    }
  }
}

/** Pull `/spielplan/kalendarium/{slug}/{season}/` detail links out of an index
 *  page (absolute or root-relative), normalized to absolute URLs. */
function addDetailUrls(html: string, urls: Set<string>): void {
  const re = /\/spielplan\/kalendarium\/([a-z0-9_-]+)\/(\d{4}-\d{4})\//g;
  for (const [, slug, season] of html.matchAll(re)) {
    if (slug && season) urls.add(`${BASE}/spielplan/kalendarium/${slug}/${season}/`);
  }
}

function parseProduction(html: string, url: string, window: ScrapeWindow): RawProduction | null {
  // OPERA GATE — composer comes only from a "Oper von …" meta description, so a
  // null composer drops ballet ("Ballett von …"), concerts and tours.
  const composer = parseComposer(html);
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html);
  if (!title) return null;

  const slugMatch = url.match(/kalendarium\/([a-z0-9_-]+)\/(\d{4}-\d{4})\//);
  const slug = slugMatch?.[1] ?? url;
  const season = slugMatch?.[2]?.replace("-", "/") ?? null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `opernhaus-zuerich/${slug}`,
    work_title: title,
    composer_name: composer,
    premiere_season: season,
    detail_url: url,
    image_url: parseImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** Composer from `<meta name="description" content="Oper von …">`. The leading
 *  "Oper von" is what gates opera in; composerFromText trims trailing life-dates
 *  ("(1842-1912)") and "nach …" clauses. */
function parseComposer(html: string): string | null {
  const m = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  const desc = m?.[1] ? decodeEntities(m[1]) : "";
  if (!/^\s*Oper von\s/i.test(desc)) return null;
  return composerFromText(desc.split(/\r?\n/)[0] ?? desc);
}

function parseTitle(html: string): string | null {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m?.[1]) return null;
  const t = stripHtml(m[1]);
  return t || null;
}

function parseImage(html: string): string | null {
  const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  return m?.[1]?.trim() || null;
}

/**
 * Performance dates. Future productions carry one JSON-LD Event per night
 * (dated, with room + status); past productions carry no Events, only a printed
 * run range ("Von {date} bis {date}" / "Am {date}"), whose bounds are emitted so
 * the production is still anchored in its season.
 */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const events = parseJsonLdPerformances(html, window);
  if (events.length > 0) return events;
  return parseRangePerformances(html, window);
}

function parseJsonLdPerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const ev of extractEventJsonLd(html)) {
    const start = typeof ev.startDate === "string" ? ev.startDate : null;
    if (!start) continue;
    const date = start.slice(0, 10) as IsoDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (window.since && date < window.since) continue;

    const time = start.length >= 16 ? start.slice(11, 16) : null;
    const loc = ev.location as { name?: string } | undefined;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date,
      time,
      venue_room: loc?.name ? decodeEntities(loc.name).trim() : null,
      status: date < today ? "past" : "scheduled",
    });
  }

  return sortPerformances(out);
}

/** Parse the printed run range — "Von 26. April 2025 bis 15. Mai 2025" or a
 *  single "Am 12. Mai 2025" — into start/end performance rows (status past). */
function parseRangePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const text = stripHtml(html);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  const push = (date: IsoDate | null) => {
    if (!date) return;
    if (window.since && date < window.since) return;
    if (seen.has(date)) return;
    seen.add(date);
    out.push({ date, status: "past" });
  };

  const range = text.match(
    /Von\s+(\d{1,2}\.\s*[A-Za-zäöü]+\s*\d{4})\s+bis\s+(\d{1,2}\.\s*[A-Za-zäöü]+\s*\d{4})/,
  );
  if (range) {
    push(parseGermanDate(range[1]));
    push(parseGermanDate(range[2]));
    return sortPerformances(out);
  }

  const single = text.match(/\bAm\s+(\d{1,2}\.\s*[A-Za-zäöü]+\s*\d{4})/);
  if (single) push(parseGermanDate(single[1]));
  return sortPerformances(out);
}

function parseGermanDate(text: string | undefined): IsoDate | null {
  if (!text) return null;
  const m = text.match(/(\d{1,2})\.\s*([A-Za-zäöü]+)\s*(\d{4})/);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}` as IsoDate;
}

function sortPerformances(rows: RawPerformance[]): RawPerformance[] {
  return rows.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/**
 * Cast + creative team. The creative team lives in `leading-team` blocks (a
 * German label + one or more linked names); a label the German credit map knows
 * is a creative function. The cast lives in `bio-legend` rows pairing a sung
 * role (`function` span) with a name (`name` span). Both are deduped.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  const teamRe = /<div class="leading-team">([\s\S]*?)<\/div>\s*<\/div>/g;
  for (const [, block] of html.matchAll(teamRe)) {
    if (!block) continue;
    const labelMatch = block.match(/class="label">\s*([\s\S]*?)\s*<\/div>/);
    const label = labelMatch?.[1] ? stripHtml(labelMatch[1]).replace(/:\s*$/, "") : "";
    if (!label) continue;
    for (const [, rawName] of block.matchAll(/class="url"[^>]*>\s*([\s\S]*?)\s*<\/a>/g)) {
      const name = rawName ? stripHtml(rawName) : "";
      if (!name) continue;
      const credit = normalizeGermanCredit(label, name);
      const key = `${credit.function ?? credit.role}|${name}`;
      if (seenCreative.has(key)) continue;
      seenCreative.add(key);
      creative_team.push(credit);
    }
  }

  const castRe =
    /<span class="function">\s*([\s\S]*?)\s*<\/span>\s*<span class="name">\s*([\s\S]*?)\s*<\/span>/g;
  for (const [, rawRole, rawName] of html.matchAll(castRe)) {
    const role = rawRole ? stripHtml(rawRole) : "";
    const name = rawName ? stripHtml(rawName) : "";
    if (!name) continue;
    const key = `${role}|${name}`;
    if (seenCast.has(key)) continue;
    seenCast.add(key);
    cast.push(role ? { role, name } : { name });
  }

  return { creative_team, cast };
}

/** German opera seasons run Aug–Jul: before August we're still in the season
 *  that started the previous calendar year. */
function currentSeasonStartYear(): number {
  const now = new Date();
  return now.getMonth() + 1 >= 8 ? now.getFullYear() : now.getFullYear() - 1;
}
