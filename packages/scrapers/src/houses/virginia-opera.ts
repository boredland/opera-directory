import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchJson, stripHtml } from "../fetch";
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
 * Virginia Opera (`json-api` strategy) — the official opera company of the
 * Commonwealth of Virginia (US/English). It is a TOURING company: every
 * production plays Norfolk (Harrison Opera House) then travels to Richmond
 * (Dominion Energy Center) and Fairfax / Northern Virginia (GMU Center for the
 * Arts), so a single production carries performances in several cities. The live
 * scrape is the published season; `backfill` appends Wikidata for the deep past.
 *
 * WordPress (Divi). There is no custom production post type — each opera is an
 * ordinary top-level `page` (`/carmen/`, `/aida/`, …), so we read the full
 * `wp/v2/pages` collection and keep only the pages that carry an opera signature:
 * a composer line AND at least one city performance block. The page's rendered
 * content (Divi shortcodes + HTML) holds everything:
 *   - composer: the `<p>` line immediately before "Sung in …" (optionally prefixed
 *     "By "), else a "Music by {Name}" / "Composed by {Name}" phrase — an ENGLISH
 *     structured field, NOT the German composerFromText.
 *   - creative team: phrase-form credits ("Conducted by {Name}", "Directed by",
 *     "Set Design by", …) in the block between the composer line and the first city
 *     heading; each phrase is mapped to our canonical function slug in-adapter.
 *   - cast: the "Cast List" block, `<b><a>{Name}</a>,</b> {Role}` rows.
 *   - performances: per-city `<h2>{City}</h2><p>…</p>` blocks listing
 *     "{Weekday}, {Month} {Day} @ {H:MM PM}" lines. The lines carry no year, so it
 *     is derived from the weekday + the page's `modified` year (a production runs
 *     inside a few weeks, so its dates share one calendar year). The city heading
 *     is the venue_room (Norfolk / Richmond / Fairfax).
 *
 * Opera filter: REQUIRE a composer. Galas, community events and lecture pages
 * publish no composer line and fail this test.
 */

const BASE = "https://vaopera.org";
const REST_PAGES = `${BASE}/wp-json/wp/v2/pages?per_page=100&_fields=slug,date,modified,content.rendered`;

/** Virginia Opera on Wikidata — the opera COMPANY (Q7934437), `instance of` opera
 *  company (Q20819922) + nonprofit organization, country USA. Verified via
 *  wbsearchentities ("Virginia Opera" → sole hit Q7934437) and the entity's P31
 *  claims (resolved Q20819922 = "opera company"). */
const WIKIDATA_QID = "Q7934437";

/** The three touring cities, mapped to the venue printed on the venue pages. */
const CITY_VENUE: Record<string, string> = {
  norfolk: "Harrison Opera House (Norfolk)",
  richmond: "Dominion Energy Center (Richmond)",
  fairfax: "GMU Center for the Arts (Fairfax)",
};

/** English phrase-form credit labels → our canonical function slugs. Production/
 *  associate/assistant variants fold onto the principal function; unmapped phrases
 *  (e.g. "Wig & Makeup") are dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conducted: "conductor",
  "music directed": "conductor",
  directed: "director",
  "production directed": "director",
  staged: "director",
  "revival directed": "director",
  "associate directed": "director",
  "assistant directed": "director",
  "set designed": "set-designer",
  "set & projection designed": "set-designer",
  "set and projection designed": "set-designer",
  "scenic designed": "set-designer",
  "scenic & projection designed": "set-designer",
  "costume designed": "costume-designer",
  "lighting designed": "lighting",
  "projection designed": "projection-designer",
  "video designed": "video-designer",
  choreography: "choreographer",
  choreographed: "choreographer",
  "movement directed": "choreographer",
  "chorus mastered": "chorus-master",
  "chorus directed": "chorus-master",
  dramaturgy: "dramaturgy",
};

interface WpPage {
  slug?: string;
  date?: string;
  modified?: string;
  content?: { rendered?: string };
}

export async function scrapeVirginiaOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const pages = await fetchJson<WpPage[]>(REST_PAGES, ctx);
    for (const page of pages) {
      try {
        const prod = parseProduction(page, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`virginia-opera: page ${page.slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("virginia-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("virginia-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "virginia-opera", productions };
}

function parseProduction(page: WpPage, window: ScrapeWindow): RawProduction | null {
  const slug = page.slug;
  const html = page.content?.rendered;
  if (!slug || !html) return null;

  const composer = parseComposer(html);
  // No composer ⇒ a gala / community-event / lecture page, not staged opera.
  if (!composer) return null;

  const anchorYear = Number.parseInt((page.modified ?? page.date ?? "").slice(0, 4), 10);
  const performances = parsePerformances(html, anchorYear, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html) || slugToTitle(slug);
  if (!title) return null;

  return {
    source_production_id: `virginia-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    language: parseLanguage(html),
    detail_url: `${BASE}/${slug}/`,
    creative_team: parseCreative(html),
    cast: parseCast(html),
    performances,
  };
}

/** Zero-width chars (the CMS prefixes some H1s with one) — ZWSP, ZWNJ, ZWJ, BOM. */
const ZERO_WIDTH = /​|‌|‍|﻿/g;

/** The page title is the H1 ("Select Page" nav aside, then `<h1>{Title}</h1>`),
 *  falling back to the slug. */
function parseTitle(html: string): string | null {
  const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").replace(ZERO_WIDTH, "");
  return h1 || null;
}

/**
 * The composer is the `<p>` line just before "Sung in …" (optionally prefixed
 * "By "), e.g. `<p>By Georges Bizet<br /><strong><em>Sung in …`. When that line
 * is absent (contemporary works), fall back to a "Music by {Name}" / "Composed by
 * {Name}" phrase. Names may be wrapped in an `<a>`.
 */
function parseComposer(html: string): string | null {
  const before = html.match(/<p>\s*(?:By\s+)?([^<]*?)<br\s*\/?>\s*(?:<[^>]*>\s*)*Sung in/i)?.[1];
  const fromBefore = before
    ? stripHtml(before)
        .replace(/^By\s+/i, "")
        .trim()
    : "";
  if (fromBefore && /[A-Za-z]/.test(fromBefore)) return fromBefore;

  const phrase = html.match(/(?:Music by|Composed by)\s+(<a[^>]*>)?([^<,]+)/i)?.[2];
  const fromPhrase = phrase ? decodeEntities(phrase).trim() : "";
  return fromPhrase && /[A-Za-z]/.test(fromPhrase) ? fromPhrase : null;
}

/** "Sung in Italian with English captions/Surtitles" → ISO 639-1. */
function parseLanguage(html: string): RawProduction["language"] {
  const lang = html.match(/Sung in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
  if (!lang) return null;
  return (
    ({
      italian: "it",
      english: "en",
      german: "de",
      french: "fr",
      russian: "ru",
      czech: "cs",
      spanish: "es",
    }[lang] as RawProduction["language"]) ?? null
  );
}

/**
 * Creative credits are phrase-form ("Conducted by {Name}", "Set Design by …") in
 * the block between the composer line and the first city heading. The trailing
 * verb of each phrase keys CREATIVE_FUNCTIONS ("Conducted" → conductor); the name
 * runs to the next tag, comma or parenthetical annotation ("(Feb. 14 & 15)").
 */
function parseCreative(html: string): RawCredit[] {
  const block = creativeBlock(html);
  const creative: RawCredit[] = [];
  const seen = new Set<string>();

  const re =
    /\b((?:[A-Z][A-Za-z]+(?:\s+(?:&(?:amp;)?|and)\s+[A-Za-z]+)?\s+)*(?:Conducted|Directed|Design|Designed|Choreograph(?:y|ed)|Mastered|Dramaturgy)) by\s+(<a[^>]*>)?([^<,(]+)/gi;
  for (const [, label, , rawName] of block.matchAll(re)) {
    const fn = CREATIVE_FUNCTIONS[normalizeLabel(label ?? "")];
    const name = cleanText(rawName ?? "");
    if (!fn || !name || !/[A-Za-z]/.test(name)) continue;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creative.push({ function: fn, name });
  }
  return creative;
}

/** "Set & Projection Design by" → "set & projection designed"; "Choreography by"
 *  → "choreography". Lowercases, decodes the `&amp;`, and folds "Design"→"designed"
 *  so the verb forms in CREATIVE_FUNCTIONS match. */
function normalizeLabel(label: string): string {
  return decodeEntities(label)
    .toLowerCase()
    .replace(/\band\b/g, "&")
    .replace(/\bdesign\b/, "designed")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decode entities, drop the stray `%22`/`%26` artifacts some Divi shortcode rows
 *  url-encode into the printed text, and collapse whitespace. */
function cleanText(value: string): string {
  return decodeEntities(value.replace(/%22/g, '"').replace(/%26/g, "&"))
    .replace(/\s+/g, " ")
    .trim();
}

/** The credit block is the slice from "Sung in" to the first city heading (or, when
 *  no city heading precedes the cast, to "Cast List" / the shortcode tail). */
function creativeBlock(html: string): string {
  const start = html.search(/Sung in/i);
  const from = start >= 0 ? start : 0;
  const ends = [
    html.search(/<h2>\s*(?:Norfolk|Richmond|Fairfax)\s*<\/h2>/i),
    html.indexOf("Cast List"),
  ].filter((i) => i > from);
  const end = ends.length ? Math.min(...ends) : html.length;
  return html.slice(from, end);
}

/**
 * Cast lives in the "Cast List" block as `<b><a>{Name}</a>,</b> {Role}` rows
 * separated by `<br />`. The role runs from the closing `</b>` to the next `<br`
 * or `</p>`.
 */
function parseCast(html: string): RawCredit[] {
  const block = html.match(/Cast List<\/h2>([\s\S]*?)<\/p>/i)?.[1];
  if (!block) return [];

  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]*>([^<]+)<\/a>\s*,?\s*<\/b>\s*([^<]*)/gi;
  for (const [, rawName, rawRole] of block.matchAll(re)) {
    const name = cleanText(rawName ?? "");
    const role = cleanText(rawRole ?? "") || null;
    if (!name) continue;
    const key = `${role ?? ""}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cast.push({ role, name });
  }
  return cast;
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
const WEEKDAYS: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 0,
};

/**
 * Each city is a `<h2>{City}</h2><p>…</p>` block of "{Weekday}, {Month} {Day} @
 * {H:MM PM}" lines. The line carries no year — it is derived from the weekday and
 * the page's `modified` year (checking that year ±1 for the one where the weekday
 * matches), so a season that wraps into the next calendar year still lands right.
 */
function parsePerformances(
  html: string,
  anchorYear: number,
  window: ScrapeWindow,
): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, city, body] of html.matchAll(
    /<h2>\s*(Norfolk|Richmond|Fairfax)\s*<\/h2>\s*<p>([\s\S]*?)<\/p>/gi,
  )) {
    const venue = CITY_VENUE[(city ?? "").toLowerCase()] ?? city ?? null;
    const text = stripHtml(body ?? "");

    for (const [, weekday, month, day, hh, mm, meridian] of text.matchAll(
      /([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2})\s*@\s*(\d{1,2}):(\d{2})\s*(AM|PM)/gi,
    )) {
      const date = resolveDate(weekday ?? "", month ?? "", Number(day), anchorYear);
      if (!date) continue;
      if (window.since && date < window.since) continue;
      const time = to24h(Number(hh), mm ?? "", meridian ?? "");
      const key = `${date}|${time}|${venue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        date,
        time,
        venue_room: venue,
        status: date < today ? "past" : "scheduled",
      });
    }
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Find the year (anchor ±1) where {month} {day} falls on {weekday}. */
function resolveDate(
  weekday: string,
  month: string,
  day: number,
  anchorYear: number,
): IsoDate | null {
  const mon = MONTHS[month.toLowerCase()];
  const wd = WEEKDAYS[weekday.toLowerCase()];
  if (!mon || wd === undefined || !day || !Number.isFinite(anchorYear)) return null;

  for (const year of [anchorYear, anchorYear - 1, anchorYear + 1]) {
    const d = new Date(Date.UTC(year, mon - 1, day));
    if (d.getUTCMonth() !== mon - 1) continue;
    if (d.getUTCDay() === wd) {
      return isoFromParts(year, mon, day);
    }
  }
  return null;
}

function to24h(hour: number, mm: string, meridian: string): string {
  let h = hour;
  const m = meridian.toLowerCase();
  if (m === "pm" && h !== 12) h += 12;
  if (m === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${mm}`;
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
