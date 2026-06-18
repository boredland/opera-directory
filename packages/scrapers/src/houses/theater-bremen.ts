import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
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
 * Theater Bremen (`spielplan-html` strategy).
 *
 * A cb-event house, but its `/de_DE/event.json` endpoint 500s for external
 * clients — happily the season index `/de_DE/programm-next` is fully server
 * rendered: one `.productions` block per show with the genre+composer line
 * ("Oper … von Composer"), so we enumerate the opera productions there. Each
 * detail page `/de_DE/programm/{slug}.{id}` carries the full Besetzung
 * (`<span class="role">Label</span> <span>[<a>]Name`) and the complete list of
 * performance dates in an `events-tickets` block ("Weekday, DD. Monat YYYY,
 * HH:MM Uhr", `<br>`-separated). Future-only → Wikidata backfill for the archive.
 */

const BASE = "https://theaterbremen.de";
const SEASON_INDEX = `${BASE}/de_DE/programm-next`;
/** Theater Bremen on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1727243";

/** The genre descriptor that opens a production's info line marks it as opera. */
const OPERA_GENRE = /\b(Oper|Operette|Musiktheater|Kammeroper|Singspiel)\b/i;

const GERMAN_MONTHS: Record<string, string> = {
  Januar: "01",
  Februar: "02",
  März: "03",
  April: "04",
  Mai: "05",
  Juni: "06",
  Juli: "07",
  August: "08",
  September: "09",
  Oktober: "10",
  November: "11",
  Dezember: "12",
};

interface IndexEntry {
  detailUrl: string;
  title: string;
  genreLine: string;
}

export async function scrapeTheaterBremen(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const index = await fetchHtml(SEASON_INDEX, ctx);
  const operas = parseIndex(index);

  const productions: RawProduction[] = [];
  for (const entry of operas) {
    try {
      const prod = await buildProduction(ctx, entry, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`theater-bremen: ${entry.detailUrl} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-bremen: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-bremen", productions };
}

/** Each `.productions` block: `<h1 class="accordeon-title"><a href="…">Title</a></h1>
 *  <p class="info">{genre line} … von {composer}<br>…`. Keep the opera ones. */
function parseIndex(html: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  const seen = new Set<string>();
  const re =
    /<h1 class="accordeon-title"><a href="(\/de_DE\/programm\/[^"]+)">([\s\S]*?)<\/a><\/h1>\s*<p class="info">([\s\S]*?)<\/p>/g;
  for (const m of html.matchAll(re)) {
    const detailUrl = `${BASE}${m[1]}`;
    const genreLine = stripHtml((m[3] ?? "").split(/<br\s*\/?>/i)[0] ?? "");
    if (!OPERA_GENRE.test(genreLine) || seen.has(detailUrl)) continue;
    seen.add(detailUrl);
    out.push({ detailUrl, title: stripHtml(m[2] ?? ""), genreLine });
  }
  return out;
}

async function buildProduction(
  ctx: FetchContext,
  entry: IndexEntry,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(entry.detailUrl, ctx);
  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseBesetzung(html);
  return {
    source_production_id: entry.detailUrl.split(".").pop() ?? entry.detailUrl,
    work_title: entry.title,
    composer_name: parseComposer(entry.genreLine),
    detail_url: entry.detailUrl,
    creative_team,
    cast,
    performances,
  };
}

/** The genre line reads "Oper in vier Akten von Georges Bizet" — composer is after "von". */
function parseComposer(genreLine: string): string | null {
  const m = genreLine.match(/\bvon\s+(.+)$/i);
  if (!m?.[1]) return null;
  return (
    m[1]
      .split(/\s+nach\s+|\s+und\s+/i)[0]
      ?.replace(/,.*$/, "")
      .trim() || null
  );
}

/** Besetzung accordion: `<span class="role">Label</span> <span>[<a …>]Name[</a>]</span>`.
 *  German function label → creative team, a character-role label → sung cast. */
function parseBesetzung(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<span class="role">([\s\S]*?)<\/span>\s*<span>([\s\S]*?)<\/span>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    const name = stripHtml(m[2] ?? "");
    const key = `${label}|${name}`;
    if (!label || !name || seen.has(key)) continue;
    seen.add(key);
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative_team.push(credit);
    else cast.push(credit);
  }
  return { creative_team, cast };
}

/** `events-tickets` block: "Weekday, DD. Monat YYYY, HH:MM Uhr [/ Premiere]", `<br>`-separated. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const block = html.match(/events-tickets[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of block.matchAll(/(\d{1,2})\.\s+(\p{L}+)\s+(\d{4}),\s+(\d{1,2}:\d{2})\s*Uhr/gu)) {
    const month = GERMAN_MONTHS[m[2] ?? ""];
    if (!month) continue;
    const date = isoFromParts(m[3] ?? "", month, m[1] ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;
    const time = m[4] ?? null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}
