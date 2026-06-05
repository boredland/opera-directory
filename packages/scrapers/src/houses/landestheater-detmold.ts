import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
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
 * Landestheater Detmold (`spielplan-html`, Django, server-rendered) — a touring
 * Landestheater that also plays guest venues (Paderborn, Bad Oeynhausen, …).
 *
 * Routed through the fetch-proxy (`proxy: true`): the site's robots.txt is
 * `Disallow: /`, so this is a deliberate maintainer decision to crawl it for the
 * directory. The full-season index /de/programm/stuecke lists one card per
 * production; opera cards carry `data-listfilters` containing "musiktheater" and a
 * `venue` label (Oper/Operette/Musical — musicals dropped). Each /de/programm/
 * {slug}/{id} detail page has the `<h1>` title, a "{genre} von {Composer}"
 * `.subtitle`, a `.cast-list` (German labels → creative team / sung roles) and a
 * `.stage-play-list` of performances (weekday/day/month — NO year, so inferred —
 * a time and a per-performance `.location` venue). Future/season → Wikidata backfill.
 */

const BASE = "https://www.landestheater-detmold.de";
/** Landestheater Detmold on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1802664";
const GERMAN_MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  märz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

export async function scrapeLandestheaterDetmold(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(`${BASE}/de/programm/stuecke`, ctx);
    for (const path of operaProductionPaths(index)) {
      try {
        const prod = await buildProduction(ctx, path, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`landestheater-detmold: ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("landestheater-detmold: index failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("landestheater-detmold: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "landestheater-detmold", productions };
}

/** Cards whose `data-listfilters` includes "musiktheater"; drop the "Musical"
 *  venue-label ones. Returns the detail paths. */
function operaProductionPaths(html: string): string[] {
  const paths = new Set<string>();
  for (const m of html.matchAll(
    /<li[^>]*data-listfilters="([^"]*musiktheater[^"]*)"([\s\S]*?)<\/li>/g,
  )) {
    const body = m[2] ?? "";
    const venue = stripHtml(body.match(/class="venue"[^>]*>([\s\S]*?)</)?.[1] ?? "");
    if (/musical/i.test(venue)) continue;
    const path = body.match(/href="(\/de\/programm\/[^"]+)"/)?.[1];
    if (path) paths.add(path);
  }
  return [...paths];
}

async function buildProduction(
  ctx: FetchContext,
  path: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}${path}`;
  const html = await fetchHtml(url, ctx);
  const title = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const subtitle = clean(html.match(/class="subtitle"[^>]*>([\s\S]*?)<\/[a-z]+>/)?.[1] ?? "");
  if (/musical/i.test(subtitle)) return null;
  const composer = composerFromText(subtitle.split("|")[0] ?? subtitle);
  if (!title || !composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseCastList(html);
  return {
    source_production_id: path.split("/")[3] ?? path,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** `.stage-play-list-item` rows: a `.day`/`.month` (no year → inferred from
 *  chronological order), a `.time`, and a per-performance `.location` venue. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  let year = Number.parseInt(today.slice(0, 4), 10);
  let prev = today;
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  // Split on the row class specifically — "stage-play-list-item" alone is also a
  // prefix of the inner -date/-info divs, which would separate date from venue.
  for (const item of html.split("stage-play-list-item row").slice(1)) {
    const day = item.match(/class="day">\s*(\d{1,2})/)?.[1];
    const month =
      GERMAN_MONTHS[
        stripHtml(item.match(/class="month">([\s\S]*?)<\/span>/)?.[1] ?? "").toLowerCase()
      ];
    if (!day || !month) continue;
    let date = `${year}-${month}-${day.padStart(2, "0")}`;
    if (date < prev) {
      year++; // the list is chronological → a month rollback means the next year
      date = `${year}-${month}-${day.padStart(2, "0")}`;
    }
    prev = date;
    if ((window.since && date < window.since) || seen.has(date)) continue;
    seen.add(date);

    const time = item.match(/class="time">\s*(\d{1,2}:\d{2})/)?.[1] ?? null;
    const venue = clean(item.match(/class="location">([\s\S]*?)<\/span>/)?.[1] ?? "") || null;
    performances.push({
      date: date as IsoDate,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** `.cast-list-item`: an instrument/role label + an artist name. A label in the
 *  German credit map is a creative function, anything else a sung role. */
function parseCastList(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  for (const m of html.matchAll(
    /cast-list-item-instrument[^>]*>([\s\S]*?)<\/span>[\s\S]*?cast-list-item-artist[^>]*>([\s\S]*?)<\/span>/g,
  )) {
    const label = clean(m[1] ?? "");
    const name = clean(m[2] ?? "");
    if (!label || !name) continue;
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative.push(credit);
    else cast.push({ role: label, name });
  }
  return { cast, creative };
}

/** Strip tags + soft hyphens (titles use U+00AD). */
function clean(s: string): string {
  return stripHtml(s).replace(/­/g, "").trim();
}
