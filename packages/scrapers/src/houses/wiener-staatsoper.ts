import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Wiener Staatsoper / Vienna State Opera (`spielplan-html` strategy).
 *
 * One of the world's top houses (Vienna, Austria), near-daily performances
 * Sep–Jun. The site is German-language SSR HTML — no schema.org Event JSON-LD
 * and no public JSON API — so this reads the rendered markup directly.
 *
 * Discovery is two indexes that both link `/kalender/detail/{slug}/` production
 * pages: the standing-repertoire index `/repertoire/` and the month calendar
 * `/kalender/oper/{year}/{month}/`. Neither index is genre-filtered — both list
 * opera, ballet and concerts together — so the OPERA GATE lives on the detail
 * page: a production is kept only when its genre block reads "Oper" AND a
 * composer is present (`<span class="production-name">`). That drops ballet
 * (genre "Ballett", whose production-name is the choreographer), concerts,
 * matinees and Kinder/Kammer formats. Backfill walks the month calendar
 * backward via its prev-month nav links (bounded by `window.since`), then
 * appends Wikidata.
 *
 * Per detail page:
 *   - composer: `<span class="production-name">` (e.g. "Georges Bizet").
 *   - performances: `accordion-button` rows carrying a German date
 *     (`date-number` + month name + year) and an optional `HH:MM` time; ticket
 *     status loads lazily via htmx and isn't in the SSR page, so status is
 *     derived from the date (past/scheduled).
 *   - cast + creative team: `data-offcanvas-title` (name) + `data-offcanvas-subtitle`
 *     (label) attribute pairs. German creative labels ("Musikalische Leitung",
 *     "Inszenierung") map via normalizeGermanCredit; anything unmapped is a sung
 *     role (verbatim fallback). The pairs repeat once per performance night, so
 *     they're deduped to the production level.
 */

const BASE = "https://www.wiener-staatsoper.at";
/** Vienna State Opera on Wikidata — Q209937 ("Vienna State Opera house", "opera
 *  house in Vienna, Austria"). Verified via wbsearchentities AND by SPARQL: it
 *  carries 14 productions via P4647/P272, whereas the separate "company" record
 *  Q113044719 carries 0, so the house QID is the one with backfill data. */
const WIKIDATA_QID = "Q209937";

const VENUE = "Wiener Staatsoper";

/** German month names (incl. the Austrian "Jänner") → 1-based month number. */
const MONTHS: Record<string, number> = {
  januar: 1,
  jänner: 1,
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

const MONTH_SLUGS = [
  "januar",
  "februar",
  "maerz",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "dezember",
];

/** How many prev-month hops the backfill walk takes before giving up (the calendar
 *  nav skips empty months, so this is a generous cap, not a month count). */
const MAX_BACKFILL_MONTHS = 240;

export async function scrapeWienerStaatsoper(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const slugs = await collectSlugs(ctx, window);
    for (const slug of slugs) {
      try {
        const html = await fetchHtml(`${BASE}/kalender/detail/${slug}/`, ctx);
        const prod = parseProduction(html, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`wiener-staatsoper: detail ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("wiener-staatsoper: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("wiener-staatsoper: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "wiener-staatsoper", productions };
}

/**
 * Collect unique production slugs. Incremental: the standing repertoire plus the
 * current and next-two month calendars. Backfill: walk the month calendar backward
 * via its prev-month nav links until `window.since` is exceeded (or the cap hits).
 */
async function collectSlugs(ctx: FetchContext, window: ScrapeWindow): Promise<string[]> {
  const slugs = new Set<string>();

  const addFrom = (html: string) => {
    for (const [, slug] of html.matchAll(/\/kalender\/detail\/([a-z0-9-]+)\//g)) {
      if (slug) slugs.add(slug);
    }
  };

  try {
    addFrom(await fetchHtml(`${BASE}/repertoire/`, ctx));
  } catch (err) {
    console.warn("wiener-staatsoper: repertoire index failed:", err);
  }

  const now = new Date();
  if (window.mode === "backfill") {
    await walkCalendarBackward(ctx, now, window.since, slugs);
  } else {
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const html = await fetchMonth(ctx, d.getFullYear(), d.getMonth() + 1);
      if (html) addFrom(html);
    }
  }

  return [...slugs];
}

/** Fetch a month calendar, returning null for an off-season month (the calendar
 *  404s for July/August, when the house is dark) so those aren't logged as errors. */
async function fetchMonth(ctx: FetchContext, year: number, month: number): Promise<string | null> {
  try {
    return await fetchHtml(monthUrl(year, month), ctx);
  } catch (err) {
    if (!/→ 404$/.test(String(err))) {
      console.warn(`wiener-staatsoper: calendar ${year}/${month} failed:`, err);
    }
    return null;
  }
}

/** Hop month-by-month backward, following each page's prev-month nav link. The
 *  nav skips months with no programme, so we follow links rather than decrement
 *  a counter; stop once the visited month falls before `since`. */
async function walkCalendarBackward(
  ctx: FetchContext,
  start: Date,
  since: IsoDate | null,
  slugs: Set<string>,
): Promise<void> {
  let year = start.getFullYear();
  let month = start.getMonth() + 1;
  const visited = new Set<string>();

  for (let hop = 0; hop < MAX_BACKFILL_MONTHS; hop++) {
    const key = `${year}-${month}`;
    if (visited.has(key)) break;
    visited.add(key);

    const html = await fetchMonth(ctx, year, month);
    if (!html) {
      // Off-season/empty month (no page, no nav): step back one calendar month
      // and retry — a populated sibling page carries the nav to keep walking.
      const d = new Date(year, month - 2, 1);
      if (since && monthEnd(d.getFullYear(), d.getMonth() + 1) < since) break;
      year = d.getFullYear();
      month = d.getMonth() + 1;
      continue;
    }
    for (const [, slug] of html.matchAll(/\/kalender\/detail\/([a-z0-9-]+)\//g)) {
      if (slug) slugs.add(slug);
    }

    const prev = previousNavMonth(html, year, month);
    if (!prev) break;
    if (since && monthEnd(prev.year, prev.month) < since) break;
    year = prev.year;
    month = prev.month;
  }
}

/** Pick the latest month-nav link strictly before (year, month) — the prev arrow. */
function previousNavMonth(
  html: string,
  year: number,
  month: number,
): { year: number; month: number } | null {
  let best: { year: number; month: number } | null = null;
  for (const [, y, m] of html.matchAll(/\/kalender\/oper\/(\d{4})\/([a-zä]+)\//g)) {
    if (!y || !m) continue;
    const mn = MONTHS[m];
    const yr = Number(y);
    if (!mn || !yr) continue;
    if (yr > year || (yr === year && mn >= month)) continue;
    if (!best || yr > best.year || (yr === best.year && mn > best.month)) {
      best = { year: yr, month: mn };
    }
  }
  return best;
}

function monthUrl(year: number, month: number): string {
  return `${BASE}/kalender/oper/${year}/${MONTH_SLUGS[month - 1]}/`;
}

function monthEnd(year: number, month: number): IsoDate {
  const last = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}` as IsoDate;
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  // OPERA GATE — genre must read "Oper"; drops ballet/concert/matinee detail pages.
  if (!isOpera(html)) return null;

  const composer = parseComposer(html);
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html) || slugToTitle(slug);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `wiener-staatsoper/${slug}`,
    work_title: title,
    composer_name: composer,
    language: parseLanguage(html),
    detail_url: `${BASE}/kalender/detail/${slug}/`,
    image_url: parseImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** True when the genre block (`text-uppercase`) reads "Oper" (not Ballett/Konzert). */
function isOpera(html: string): boolean {
  for (const [, genre] of html.matchAll(/text-uppercase">\s*([A-Za-zÄÖÜäöü]+)\s*<\/p>/g)) {
    if (genre?.toLowerCase() === "oper") return true;
  }
  return false;
}

function parseComposer(html: string): string | null {
  const m = html.match(/class="production-name">([\s\S]*?)<\/span>/);
  if (!m?.[1]) return null;
  const name = stripHtml(m[1]);
  return name.length >= 3 && name.length <= 60 ? name : null;
}

/** The headline `content` attribute carries literal newlines and double-encoded
 *  entities ("aus dem&amp;nbsp;Serail"); decode twice, drop soft hyphens, collapse. */
function parseTitle(html: string): string | null {
  const m = html.match(/id="eventHeadline"[^>]*\bcontent="([^"]*)"/);
  if (!m?.[1]) return null;
  const t = decodeEntities(decodeEntities(m[1])).replace(/­/g, "").replace(/\s+/g, " ").trim();
  return t || null;
}

function parseImage(html: string): string | null {
  const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  return m?.[1]?.trim() || null;
}

function parseLanguage(html: string): RawProduction["language"] {
  const m = html.match(/Sprache\s*<strong>\s*([^<]+?)\s*<\/strong>/);
  const label = m?.[1] ? decodeEntities(m[1]).trim().toLowerCase() : "";
  const code = LANGUAGES[label];
  return code ?? null;
}

const LANGUAGES: Record<string, RawProduction["language"]> = {
  deutsch: "de",
  italienisch: "it",
  französisch: "fr",
  englisch: "en",
  russisch: "ru",
  tschechisch: "cs",
  französich: "fr",
};

/**
 * Performance rows are `accordion-button` anchors, each with a German date
 * (`date-number` + month name + year) and an optional `HH:MM`. Status is derived
 * from the date — the live ticket state loads lazily via htmx, not in the SSR DOM.
 */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const rowRe = /<a\b[^>]*accordion-button[^>]*>([\s\S]*?)<\/a>/g;
  for (const [, row] of html.matchAll(rowRe)) {
    if (!row) continue;
    const dm = row.match(/date-number">\s*(\d{1,2})\.?\s*<\/span>\s*([A-Za-zÄÖÜäöü]+)/);
    const ym = row.match(/<strong>\s*(\d{4})\s*<\/strong>/);
    if (!dm?.[1] || !dm[2] || !ym?.[1]) continue;
    const month = MONTHS[dm[2].toLowerCase()];
    if (!month) continue;
    const date = isoFromParts(ym[1] ?? "", month, dm[1]);
    if (!date) continue;

    const tm = row.match(/col-2">\s*<p>\s*(\d{1,2}:\d{2})/);
    const time = tm?.[1] ? tm[1].padStart(5, "0") : null;

    if (window.since && date < window.since) continue;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date,
      time,
      venue_room: VENUE,
      status: date < today ? "past" : "scheduled",
    });
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/**
 * Cast + creative team from `data-offcanvas-title` (name) / `data-offcanvas-subtitle`
 * (label) pairs. A label the German credit map knows is a creative function; the
 * rest are sung roles. Pairs repeat per night, so both lists are deduped.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  const pairRe = /data-offcanvas-title="([^"]*)"\s+data-offcanvas-subtitle="([^"]*)"/g;
  for (const [, rawName, rawLabel] of html.matchAll(pairRe)) {
    if (rawName == null || rawLabel == null) continue;
    const name = decodeEntities(rawName).trim();
    const label = decodeEntities(rawLabel).trim();
    if (!name || !label) continue;

    const credit = normalizeGermanCredit(label, name);
    if (credit.function) {
      const key = `${credit.function}|${name}`;
      if (seenCreative.has(key)) continue;
      seenCreative.add(key);
      creative_team.push(credit);
    } else {
      const key = `${label}|${name}`;
      if (seenCast.has(key)) continue;
      seenCast.add(key);
      cast.push({ role: label, name });
    }
  }

  return { creative_team, cast };
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
