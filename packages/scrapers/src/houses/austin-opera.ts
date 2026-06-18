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

/**
 * Austin Opera (`spielplan-html` strategy) — US opera company in Austin, Texas
 * (OPERA America; a year-round season ~Oct–Apr on the Long Center's Dell Hall).
 * The live scrape is the announced season; `backfill` appends Wikidata.
 *
 * Ticketing is Tessitura (my.austinopera.org) but its endpoints sit behind a
 * login redirect with no public production JSON, so all metadata comes from the
 * marketing-site SSR HTML. The homepage links the current season index at
 * `/shows-events/{YYYY-YYYY}-season/`, which links each staged opera at
 * `/shows-events/{YYYY-YYYY}-season/{slug}/`; the `/shows-events/events/` items
 * (galas, recitals, concert series) are not under a season path and drop out.
 * Each production page (only Organization JSON-LD — no Event/cast) yields:
 *   - title: `og:title`.
 *   - composer: the Creative-Team person card whose function is "Composer"
 *     (contemporary works print one); standard rep omits it, so we fall back to
 *     the hero `.pre-head` above the `<h1>` — but only when that text is a name,
 *     not a billing tag ("Texas Premiere", "World Premiere Commission"). This is
 *     the opera gate.
 *   - cast + creative: `person` cards (`h3.h5-styled.nm` name + `p.large` label),
 *     split on the `id="…-Creative"` section boundary — cards before it are cast
 *     (label = sung role), cards in/after it are creative (label = ENGLISH
 *     function, mapped in-adapter via CREATIVE_FUNCTIONS; "Composer" is consumed
 *     as the composer, not re-emitted; unmapped labels dropped).
 *   - performances: the hero date line ("October 1-4, 9 & 13, 2026", "April 18,
 *     22 & 24, 2027") — a compact list with a shared trailing year. No per-night
 *     time is published on the marketing page, so time is left null; venue is the
 *     Long Center's Dell Hall. Status is past/scheduled by date. Honors
 *     window.since.
 *   - language: the "Sung in {Language}…" Show-Details line.
 */

const BASE = "https://austinopera.org";
/** Austin Opera on Wikidata — the opera COMPANY, recorded under its founding
 *  name "Austin Lyric Opera" (founded 1986; rebranded "Austin Opera" in 2013,
 *  which Wikidata keeps as the entity, instance-of musical group). Verified via
 *  wbsearchentities: the sole "Austin Opera" hit is Q4823180 = "Austin Lyric
 *  Opera", aliased "Austin Opera", described "US musical group". */
const WIKIDATA_QID = "Q4823180";

const VENUE = "Long Center for the Performing Arts, Dell Hall";

/** English creative-team labels (the card `p.large` text, lower-cased) → our
 *  canonical function slugs. The house prints a sponsored Music-Director title
 *  ("Sarah & Ernest Butler Music Director") and short forms ("Lighting Design",
 *  "Choreography"), so matching is substring-based (longest key wins). "Composer"
 *  is handled separately (it sets the work's composer). Unmodeled labels (Audio
 *  Designer, etc.) match nothing and are dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Array<[needle: string, fn: string]> = [
  ["music director", "conductor"],
  ["conductor", "conductor"],
  ["stage director", "director"],
  ["revival director", "director"],
  ["associate director", "director"],
  ["assistant director", "director"],
  ["director", "director"],
  ["scenic designer", "set-designer"],
  ["set designer", "set-designer"],
  ["costume design", "costume-designer"],
  ["lighting", "lighting"],
  ["projection", "projection-designer"],
  ["video", "video-designer"],
  ["choreograph", "choreographer"],
  ["movement director", "choreographer"],
  ["chorus master", "chorus-master"],
  ["chorus director", "chorus-master"],
  ["dramaturg", "dramaturgy"],
];

export async function scrapeAustinOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const url of await collectProductionUrls(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(url, ctx), url, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`austin-opera: production ${url} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("austin-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("austin-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "austin-opera", productions };
}

/** The homepage links each season index at `/shows-events/{YYYY-YYYY}-season/`;
 *  each season page links its staged operas at `…-season/{slug}/`. Events
 *  (`/shows-events/events/…`) live outside any season path and never appear here. */
async function collectProductionUrls(ctx: FetchContext): Promise<string[]> {
  const seasons = new Set<string>();
  try {
    const home = await fetchHtml(`${BASE}/`, ctx);
    for (const [, season] of home.matchAll(/\/shows-events\/(\d{4}-\d{4}-season)\//g)) {
      if (season) seasons.add(season);
    }
  } catch (err) {
    console.warn("austin-opera: homepage failed:", err);
  }

  const urls = new Set<string>();
  for (const season of seasons) {
    try {
      const html = await fetchHtml(`${BASE}/shows-events/${season}/`, ctx);
      const re = new RegExp(`/shows-events/${season}/([^"/#?]+)/`, "g");
      for (const [, slug] of html.matchAll(re)) {
        if (slug) urls.add(`${BASE}/shows-events/${season}/${slug}/`);
      }
    } catch (err) {
      console.warn(`austin-opera: season ${season} failed:`, err);
    }
  }
  return [...urls];
}

interface Card {
  name: string;
  label: string;
}

function parseProduction(html: string, url: string, window: ScrapeWindow): RawProduction | null {
  const { cast: castCards, creative: creativeCards } = parseCards(html);

  const composer = composerOf(creativeCards, html);
  // No composer ⇒ a non-opera season item that slipped past the season-path
  // scope (or a teaser with no work). This is the opera gate.
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html);
  if (!title) return null;

  return {
    source_production_id: sourceId(url),
    work_title: title,
    composer_name: composer,
    language: languageCode(html),
    detail_url: url,
    image_url: html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1] ?? null,
    creative_team: parseCreative(creativeCards),
    cast: parseCast(castCards),
    performances,
  };
}

/** og:title is the bare work title ("La traviata", "Thaïs"). */
function parseTitle(html: string): string | null {
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  const title = og ? decodeEntities(og).trim() : "";
  return title || null;
}

/**
 * Person cards (`h3.h5-styled.nm` name + the following `p.large` label) split on
 * the `id="…-Creative"` section boundary: cards before it are cast (label = sung
 * role), cards from it on are creative (label = function). When a page has no
 * Cast section (e.g. a creative-only listing) every card falls on the creative
 * side, which is harmless — those carry function labels, not roles.
 */
function parseCards(html: string): { cast: Card[]; creative: Card[] } {
  const boundary = html.search(/<section class="block people[^"]*"[^>]*id="[^"]*-Creative"/);
  const cast: Card[] = [];
  const creative: Card[] = [];
  const re = /<h3 class="h5-styled nm">([\s\S]*?)<\/h3>[\s\S]*?<p class="large">([\s\S]*?)<\/p>/g;
  for (const m of html.matchAll(re)) {
    const name = stripDebutMark(stripHtml(m[1] ?? ""));
    const label = stripDebutMark(stripHtml(m[2] ?? ""));
    if (!name || !label) continue;
    ((boundary >= 0 && (m.index ?? 0) >= boundary ? creative : cast) as Card[]).push({
      name,
      label,
    });
  }
  return { cast, creative };
}

/** Composer: the creative card labelled "Composer" (contemporary works), else
 *  the hero `.pre-head` above the `<h1>` — accepted only when it reads like a
 *  name rather than a billing tag (premiere/commission/etc.). */
function composerOf(creative: Card[], html: string): string | null {
  const card = creative.find((c) => /\bcomposer\b/i.test(c.label));
  if (card) return card.name;

  const h1 = html.search(/<h1[\s>]/);
  if (h1 < 0) return null;
  const matches = [...html.slice(0, h1).matchAll(/<div class="pre-head">([^<]*)<\/div>/g)];
  const text = stripHtml(matches.at(-1)?.[1] ?? "");
  if (!text || !looksLikeComposer(text)) return null;
  return text;
}

/** Hero pre-head holds EITHER the composer OR a billing tag. A name is short,
 *  has no billing keyword, and isn't a bare "premiere"/"commission" phrase. */
function looksLikeComposer(text: string): boolean {
  if (/premiere|commission|presents|series|gala|concert|recital/i.test(text)) return false;
  const words = text.split(/\s+/);
  return words.length >= 2 && words.length <= 5 && /[A-Za-z]/.test(text);
}

function parseCast(cards: Card[]): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const { name, label } of cards) {
    const key = `${label}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role: label, name });
  }
  return out;
}

function parseCreative(cards: Card[]): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const { name, label } of cards) {
    if (/\bcomposer\b/i.test(label)) continue;
    const fn = mapFunction(label);
    if (!fn) continue;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ function: fn, name });
  }
  return out;
}

function mapFunction(label: string): string | null {
  const l = label.toLowerCase();
  for (const [needle, fn] of CREATIVE_FUNCTIONS) {
    if (l.includes(needle)) return fn;
  }
  return null;
}

/** The hero date line is a compact list with a shared trailing year and (mostly)
 *  a shared leading month — "October 1-4, 9 & 13, 2026", "April 18, 22 & 24,
 *  2027". Ranges ("1-4") expand to each day. No time is published. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const raw = stripHtml(
    html.match(/<div class="hero__text[^"]*">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "",
  );
  if (!raw) return [];

  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const date of expandDates(raw)) {
    if (window.since && date < window.since) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({
      date,
      time: null,
      venue_room: VENUE,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const MONTHS: Record<string, string> = {
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

/**
 * "October 1-4, 9 & 13, 2026" → every day in October 2026 it names. Walk the
 * string left to right tracking the current month and the trailing year; emit a
 * day for each number, expanding "N-M" ranges. A month token resets the current
 * month, so multi-month lines ("April 30 & May 1") still resolve correctly.
 */
function expandDates(text: string): IsoDate[] {
  const year = text.match(/\b(\d{4})\b/)?.[1];
  if (!year) return [];

  const dates: IsoDate[] = [];
  let month: string | null = null;

  // \d{4} is matched (and skipped) before \d{1,2} so the trailing year isn't
  // re-split into two day numbers ("2026" → "20" + "26").
  for (const tok of text.matchAll(/([A-Za-z]+)|(\d{4})|(\d{1,2})\s*-\s*(\d{1,2})|(\d{1,2})/g)) {
    const [, word, fourDigit, rangeA, rangeB, single] = tok;
    if (word) {
      const m = MONTHS[word.toLowerCase()];
      if (m) month = m;
      continue;
    }
    if (fourDigit || !month) continue;
    if (rangeA && rangeB) {
      const start = Number.parseInt(rangeA, 10);
      const end = Number.parseInt(rangeB, 10);
      if (end >= start && end <= 31) {
        for (let d = start; d <= end; d++) {
          const iso = isoDay(year, month, d);
          if (iso) dates.push(iso);
        }
      }
      continue;
    }
    if (single) {
      const n = Number.parseInt(single, 10);
      if (n >= 1 && n <= 31) {
        const iso = isoDay(year, month, n);
        if (iso) dates.push(iso);
      }
    }
  }
  return dates;
}

function isoDay(year: string, month: string, day: number): IsoDate | null {
  return isoFromParts(year, month, day);
}

/** "Sung in Italian…" / "Sung in Spanish & English…" → the first language's code. */
function languageCode(html: string): RawProduction["language"] {
  const first = stripHtml(html)
    .match(/Sung in\s+([A-Za-z]+)/i)?.[1]
    ?.toLowerCase();
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

/** Drop trailing debut/cover marks ("*", "+", "†") the house appends to names
 *  and sometimes to a sung role. */
function stripDebutMark(text: string): string {
  return text.replace(/[*+†‡]+$/, "").trim();
}

function sourceId(url: string): string {
  const m = url.match(/\/shows-events\/([^/]+)\/([^/]+)\/?$/);
  return m ? `austin-opera/${m[1]}/${m[2]}` : `austin-opera/${url}`;
}
