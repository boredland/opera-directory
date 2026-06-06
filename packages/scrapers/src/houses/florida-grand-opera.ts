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

/**
 * Florida Grand Opera (`spielplan-html` strategy) — a year-round US opera company
 * (US/English) performing across TWO cities: Miami (Adrienne Arsht Center / Ziff
 * Ballet Opera House) and Fort Lauderdale (Broward Center / Au-Rene Theater). The
 * live scrape is the current + announced season; `backfill` appends Wikidata for
 * the deep past.
 *
 * WordPress (All in One SEO + WPBakery). The page JSON-LD is only AIOSEO
 * WebPage/Organization — no Event/cast — so everything comes from SSR HTML. The
 * `page-sitemap.xml` enumerates every `/season{YY-YY}/{slug}/` page; opera and
 * non-opera (galas, songfests, all-star concerts, "the-making-of" featurettes)
 * share the path, and the composer gate below separates them.
 *
 * A production page carries an "info block" that is the reliable structured spine:
 *   - title + composer: `<strong>{TITLE}</strong><br><strong>By: {Composer}</strong>`
 *     (the case of the title and "By"/"by" varies between seasons).
 *   - language: a "Sung in {Language}" line in the same block.
 *   - venue/date: one `<p><strong>{CITY}<br>{Venue}</strong></p>` immediately
 *     followed by `<div class="standard-arrow"><ul><li>{date} at {time}</li>…</ul>`
 *     PER CITY — a two-city run yields a Miami block AND a Fort Lauderdale block,
 *     each mapped to its own `venue_room`/city.
 *   - cast + creative: one `<table>` of `<td>{Label}:</td><td>{Name}</td>` rows.
 *     A row whose label is a known function (CREATIVE_FUNCTIONS) is creative; any
 *     other label is a sung character → cast. Placeholder values (TBA/PENDING) and
 *     the supertitle-credit rows ("English/Spanish titles by") are dropped.
 *
 * Opera filter: REQUIRE a composer (the `By:` line). The non-opera season items
 * publish no such block and fail this test. An older legacy page layout (past
 * productions, no `standard-arrow` lists) yields no dated performances and falls
 * to the Wikidata backfill instead — out of scope for the live leg by design.
 */

const BASE = "https://fgo.org";
const SITEMAP = `${BASE}/page-sitemap.xml`;

/** Florida Grand Opera on Wikidata — the opera COMPANY. Verified via
 *  wbsearchentities: Q2903728 = "Florida Grand Opera", description "opera company
 *  in Miami, Florida, United States". */
const WIKIDATA_QID = "Q2903728";

/** The two cities FGO performs in, keyed by the CITY heading printed above each
 *  date list. Drives the per-performance `venue_room` so Miami and Fort Lauderdale
 *  nights are distinguishable downstream. */
const CITIES: Record<string, string> = {
  MIAMI: "Miami",
  "FORT LAUDERDALE": "Fort Lauderdale",
};

/** English credit-table labels → our canonical function slugs. Assistant/associate
 *  variants fold onto the principal function; combined design labels map to the
 *  leading discipline. Unmapped labels (Wig/Makeup, Fight, Stage Manager, etc.) are
 *  NOT creative functions — they fall through and, not being characters either, are
 *  dropped by the cast filter rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "assistant conductor": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "scenic design": "set-designer",
  "scenic & projection design": "set-designer",
  "scenic & costume design": "set-designer",
  "set and projection designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "associate lighting designer": "lighting",
  "projection designer": "projection-designer",
  "projection design": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

/** Credit-table labels that are neither a mapped function nor a sung role — admin
 *  rows that must not be misread as cast. */
const NON_CAST_LABELS = new Set([
  "projection programmer",
  "production stage manager",
  "fight choreographer",
  "fight team coordinator",
  "wig and makeup designer",
  "assistant wig and makeup designer",
  "english titles by",
  "spanish titles by",
  "production",
]);

const PLACEHOLDER = /^(tba|pending|tbd)$/i;

export async function scrapeFloridaGrandOpera(
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
        console.warn(`florida-grand-opera: production ${url} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("florida-grand-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("florida-grand-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "florida-grand-opera", productions };
}

/** The page sitemap lists every `/season{YY-YY}/{slug}/` page (operas + non-operas
 *  together); the composer gate filters non-operas downstream. */
async function collectProductionUrls(ctx: FetchContext): Promise<string[]> {
  const urls = new Set<string>();
  const xml = await fetchHtml(SITEMAP, ctx);
  for (const [, url] of xml.matchAll(/(https:\/\/fgo\.org\/season\d{2}-\d{2}\/[a-z0-9-]+\/)/g)) {
    if (url) urls.add(url);
  }
  return [...urls];
}

function parseProduction(html: string, url: string, window: ScrapeWindow): RawProduction | null {
  const info = parseInfoBlock(html);
  // No "By: {Composer}" info block ⇒ a gala/concert/featurette, not staged opera.
  if (!info?.composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: url.replace(`${BASE}/`, "florida-grand-opera/").replace(/\/$/, ""),
    work_title: info.title,
    composer_name: info.composer,
    premiere_season: seasonFromUrl(url),
    language: info.language,
    detail_url: url,
    creative_team,
    cast,
    performances,
  };
}

interface InfoBlock {
  title: string;
  composer: string | null;
  language: RawProduction["language"];
}

/** The structured spine: `<strong>{TITLE}</strong><br><strong>By: {Composer}</strong>`
 *  plus a "Sung in {Language}" line nearby. Title-cased here for consistency. */
function parseInfoBlock(html: string): InfoBlock | null {
  const m = html.match(
    /<strong>([^<]{2,80})<\/strong>\s*<br\s*\/?>\s*<strong>[Bb]y:?\s*([^<]{2,80})<\/strong>/,
  );
  if (!m) return null;
  const title = titleCase(stripHtml(m[1] ?? ""));
  const composer = titleCase(stripHtml(m[2] ?? ""));
  if (!title || !composer) return null;
  return { title, composer, language: parseLanguage(html) };
}

const LANGUAGES: Record<string, RawProduction["language"]> = {
  italian: "it",
  english: "en",
  german: "de",
  french: "fr",
  russian: "ru",
  czech: "cs",
  spanish: "es",
};

function parseLanguage(html: string): RawProduction["language"] {
  const lang = html.match(/Sung in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
  return (lang && LANGUAGES[lang]) || null;
}

/**
 * Per-city performance rows. Each city is a `<p><strong>{CITY}<br>{Venue}</strong></p>`
 * heading directly followed by a `standard-arrow` list of `<li>{date}, at {time}</li>`
 * entries (the `<li>` text is sometimes wrapped in a `<span>`). Honors window.since.
 */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const re =
    /<p><strong>([A-Z][A-Z .]+?)<br\s*\/?>\s*([^<]+?)<\/strong><\/p>[\s\S]*?<div class="standard-arrow"><ul>([\s\S]*?)<\/ul>/g;
  for (const [, cityHeading, venueName, list] of html.matchAll(re)) {
    const city =
      CITIES[
        stripHtml(cityHeading ?? "")
          .trim()
          .toUpperCase()
      ];
    const venue = `${city ?? stripHtml(cityHeading ?? "")} — ${stripHtml(venueName ?? "")}`.trim();

    for (const [, li] of (list ?? "").matchAll(/<li>([\s\S]*?)<\/li>/g)) {
      const text = stripHtml(li ?? "");
      const date = parseDate(text);
      if (!date) continue;
      if (window.since && date < window.since) continue;
      const time = parseTime(text);
      const key = `${date}|${time ?? ""}|${venue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date, time, venue_room: venue, status: date < today ? "past" : "scheduled" });
    }
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/**
 * Cast + creative share one `<table>` of `<td>{Label}:</td><td>{Name}</td>` rows.
 * A mapped function label → creative; any other label is a sung character → cast.
 * Placeholder values (TBA/PENDING) and known admin/supertitle labels are dropped.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, rawLabel, rawName] of html.matchAll(
    /<td>([^<]+?):?\s*<\/td>\s*<td>([^<]*)<\/td>/g,
  )) {
    const label = stripHtml(rawLabel ?? "")
      .replace(/:$/, "")
      .trim();
    // Strip FGO's debut markers (* / ** / ***) and the per-night date ranges some
    // double-cast roles append, e.g. "Roberto Alagna (3/7, 3/10) **".
    const name = stripHtml(rawName ?? "")
      .replace(/\s*\*+\s*$/, "")
      .replace(/\s*\([\d/,\s&-]+\)\s*$/, "")
      .trim();
    if (!label || !name || PLACEHOLDER.test(name)) continue;

    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    if (fn) {
      const key = `${fn}|${name}`;
      if (seenCreative.has(key)) continue;
      seenCreative.add(key);
      creative_team.push({ function: fn, name });
      continue;
    }

    if (NON_CAST_LABELS.has(label.toLowerCase()) || /^character$/i.test(label)) continue;
    const key = `${label}|${name}`;
    if (seenCast.has(key)) continue;
    seenCast.add(key);
    cast.push({ role: label, name });
  }
  return { creative_team, cast };
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** "Mar 7, 2026, at 7:00pm" / "April 17, 2027 at 7:00 PM" → "2026-03-07". */
function parseDate(text: string): IsoDate | null {
  const m = text.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()];
  if (!month) return null;
  const day = (m[2] ?? "").padStart(2, "0");
  return `${m[3]}-${month}-${day}` as IsoDate;
}

/** "7:00pm" / "7:00 PM" / "3:00pm" → 24h "HH:MM"; null when no time is printed. */
function parseTime(text: string): string | null {
  const m = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  let hour = Number.parseInt(m[1] ?? "", 10);
  const meridian = (m[3] ?? "").toLowerCase();
  if (meridian === "pm" && hour !== 12) hour += 12;
  if (meridian === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

/** "/season26-27/nabucco/" → "2026/27". */
function seasonFromUrl(url: string): string | null {
  const m = url.match(/\/season(\d{2})-(\d{2})\//);
  return m ? `20${m[1]}/${m[2]}` : null;
}

/** Lowercase particles that stay lowercase mid-title across the opera languages FGO
 *  sings ("Lucia di Lammermoor", "Die Fledermaus" keeps its leading cap). */
const LOWERCASE_PARTICLES = new Set([
  "di",
  "de",
  "del",
  "della",
  "la",
  "le",
  "les",
  "il",
  "lo",
  "des",
  "du",
  "et",
  "e",
  "and",
  "of",
  "the",
  "von",
  "der",
]);

/** Upper-cased headings (NABUCCO, LUCIA DI LAMMERMOOR) → "Nabucco", "Lucia di
 *  Lammermoor"; already-mixed-case strings are left untouched. */
function titleCase(text: string): string {
  const t = decodeEntities(text).trim();
  if (!t || t !== t.toUpperCase()) return t;
  return t
    .toLowerCase()
    .split(/(\s+)/)
    .map((word, i) =>
      i > 0 && LOWERCASE_PARTICLES.has(word) ? word : word.replace(/\b\w/, (c) => c.toUpperCase()),
    )
    .join("");
}
