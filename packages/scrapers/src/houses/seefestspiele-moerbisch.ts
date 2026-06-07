import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Seefestspiele Mörbisch — Mörbisch am See/Burgenland, Austria (`spielplan-html`,
 * FESTIVAL). The lake-stage festival on the Neusiedlersee — the open-air Seebühne
 * Mörbisch, traditionally Austria's flagship OPERETTA stage (Strauss, Lehár, Kálmán),
 * with some years staging musicals/opera. Seasonal: one edition each summer
 * (runs ~July–August), so a live scrape sees only the CURRENT edition; past
 * editions come from Wikidata backfill (coverage is thin for this house).
 *
 * TYPO3 site, no schema.org Event JSON-LD. The single main lyric production lives
 * under `/programm/{slug}/` with three sub-pages: `infos-zum-stueck` (title, run
 * year, the "Termine" date grid, composer in the descriptive prose), `leading-team`
 * (creative team), `besetzung` (cast). The production slug is discovered from the
 * homepage "Programm" nav, dropping `gastveranstaltungen` (guest concerts / Schlager
 * galas) and keeping only the staged lyric work.
 *
 * Composer is the gate. The page carries no structured composer field, so it is
 * read from the infos prose: an explicit "Musik von …" credit first, then the
 * `composerFromText` heuristic over the run-subtitle (catches the operetta-year
 * "Operette von Johann Strauss" subtitles), then the musical-creator phrasing
 * ("… X und Y … Musical …"). A production with no recoverable composer is dropped.
 *
 * Dates are a grid of "DO 16.07. 20:30 UHR" cells under the "Termine" heading; the
 * year rides in the run-range subtitle ("16. Juli - 22. August 2026"). Venue is
 * the Seebühne Mörbisch. Credits are `<h2>Label</h2> … <h3>Name</h3>` blocks
 * (German function label → creative team; character label → cast).
 */

const BASE = "https://www.seefestspiele-moerbisch.at";
const VENUE = "Seebühne Mörbisch";
/** Seefestspiele Mörbisch on Wikidata — verified via wbsearchentities ("music
 *  festival on a lake stage in Mörbisch, Austria"); P4647/P272 backfill is sparse. */
const WIKIDATA_QID = "Q365976";

export async function scrapeSeefestspieleMoerbisch(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    for (const slug of await productionSlugs(ctx)) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`seefestspiele-moerbisch: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("seefestspiele-moerbisch: scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("seefestspiele-moerbisch: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "seefestspiele-moerbisch", productions };
}

/** The current edition's lyric production slug(s) from the homepage "Programm" nav,
 *  dropping the `gastveranstaltungen` guest-concert section. */
async function productionSlugs(ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(`${BASE}/`, ctx);
  const slugs = new Set<string>();
  for (const [, slug] of html.matchAll(/href="\/programm\/([a-z0-9-]+)\//g)) {
    if (slug && slug !== "gastveranstaltungen") slugs.add(slug);
  }
  return [...slugs];
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const infoUrl = `${BASE}/programm/${slug}/infos-zum-stueck/`;
  const html = await fetchHtml(infoUrl, ctx);
  const text = stripHtml(html);

  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!title) return null;

  const composer = composerOf(text);
  if (!composer) return null;

  const year = runYear(html);
  const performances = parseTermine(html, year, window);

  const creative = await fetchCredits(ctx, `${BASE}/programm/${slug}/leading-team/`);
  const cast = await fetchCredits(ctx, `${BASE}/programm/${slug}/besetzung/`);

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    premiere_season: year ? String(year) : null,
    detail_url: infoUrl,
    creative_team: creative.map((c) => normalizeGermanCredit(c.label, c.name)),
    cast: cast.map((c) => ({ role: c.label, name: c.name })),
    performances,
  };
}

/** Composer from the infos prose: explicit "Musik von" credit, then the operetta
 *  "… von {Composer}" subtitle heuristic, then the musical-creator phrasing. */
function composerOf(text: string): string | null {
  const musik = text.match(/Musik(?:al)?\s*(?:von|:)\s*([A-ZÄÖÜ][^,.;(]+)/);
  if (musik?.[1]) {
    const name = musik[1].split(/\s+(?:und|nach|mit)\b/)[0]?.trim();
    if (name && name.length >= 3) return name;
  }

  // The composer in a "Musical-Genre" edition is named as the first creator that
  // "verwandelte" the source into the musical ("… Jerry Herman und Harvey Fierstein
  // … Musical …"); the librettist follows the "und".
  const creator = text.match(
    /verwandelten?\s+([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)+?)\s+und\b/,
  );
  if (creator?.[1]) return creator[1].trim();

  return composerFromText(text);
}

/** Edition year from the run-range subtitle, e.g. "16. Juli - 22. August 2026". */
function runYear(html: string): number | null {
  const m = stripHtml(html).match(/\b(20\d{2})\b/);
  return m?.[1] ? Number.parseInt(m[1], 10) : null;
}

/** The "Termine" grid: cells "DO 16.07. 20:30 UHR" (weekday DD.MM. HH:MM). The year
 *  is shared from the run subtitle. */
function parseTermine(html: string, year: number | null, window: ScrapeWindow): RawPerformance[] {
  if (!year) return [];
  const text = stripHtml(html);
  const block = text.slice(text.indexOf("Termine"));
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const [, dd, mm, hh, min] of block.matchAll(
    /\b(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2})[:.](\d{2})\s*UHR/gi,
  )) {
    const date = `${year}-${(mm ?? "").padStart(2, "0")}-${(dd ?? "").padStart(2, "0")}` as IsoDate;
    const time = `${(hh ?? "").padStart(2, "0")}:${min}`;
    const key = `${date}|${time}`;
    if ((window.since && date < window.since) || seen.has(key)) continue;
    seen.add(key);
    performances.push({
      date,
      time,
      venue_room: VENUE,
      status: date < today ? "past" : "scheduled",
    });
  }

  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** Credit blocks on the leading-team / besetzung pages: `<h2>Label</h2>` followed by
 *  `<h3>Name</h3>` (an image figure sits between them). One label may carry several
 *  names (alternating casts) across consecutive blocks. */
async function fetchCredits(
  ctx: FetchContext,
  url: string,
): Promise<{ label: string; name: string }[]> {
  let html: string;
  try {
    html = await fetchHtml(url, ctx);
  } catch (err) {
    console.warn(`seefestspiele-moerbisch: ${url} failed:`, err);
    return [];
  }

  const credits: { label: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const [, rawLabel, rawName] of html.matchAll(
    /<h2[^>]*>((?:(?!<\/h2>)[\s\S])*?)<\/h2>(?:(?!<h2)[\s\S])*?<h3[^>]*>([\s\S]*?)<\/h3>/g,
  )) {
    const label = stripHtml(rawLabel ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const name = stripHtml(rawName ?? "").trim();
    if (!label || !name || /^termine$/i.test(label)) continue;
    const key = `${label}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    credits.push({ label, name });
  }
  return credits;
}
