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
 * Theater Krefeld und Mönchengladbach — the shared "Gemeinschaftstheater" of the
 * two cities (`spielplan-html`, WordPress, fully server-rendered).
 *
 * The `/sparte/musiktheater/` archive lists the music-theatre productions; each
 * `/spielplan/{slug}/` detail page carries the title, a "// Musik von {Composer}"
 * subtitle, ISO `<time datetime>` performances (across BOTH cities' venues) and a
 * Leitung/Besetzung credits block. The Musiktheater sparte also holds musicals,
 * an oratorio, concerts and a gala — dropped via a genre blacklist + a required
 * composer. Detail pages render only upcoming performances → Wikidata backfill
 * covers history. (The WP REST API exposes the productions but with empty bodies,
 * so the HTML is the only complete source.)
 */

const BASE = "https://theater-kr-mg.de";
/** Theater Krefeld und Mönchengladbach on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1626214";
/** Music-theatre sparte entries that aren't opera/operetta. */
const NON_OPERA = /\b(musical|oratorium|konzert|gala|revue|liederabend|song)\b/i;

export async function scrapeTheaterKrefeldMoenchengladbach(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(`${BASE}/sparte/musiktheater/`, ctx);
    for (const slug of productionSlugs(index)) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-krefeld-moenchengladbach: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-krefeld-moenchengladbach: index failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-krefeld-moenchengladbach: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-krefeld-moenchengladbach", productions };
}

/** Detail links are /spielplan/{slug}/; the season-archive /spielplan/spielzeit/…
 *  link has an extra path segment, so a single-slug filter drops it. */
function productionSlugs(html: string): string[] {
  const slugs = new Set<string>();
  for (const m of html.matchAll(/href="https:\/\/theater-kr-mg\.de\/spielplan\/([^"/]+)\/"/g)) {
    if (m[1] && m[1] !== "spielzeit") slugs.add(m[1]);
  }
  return [...slugs];
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}/spielplan/${slug}/`, ctx);
  const branch = stripHtml(html.match(/production-header__branch[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
  if (!/Musiktheater/i.test(branch)) return null;

  const title = stripHtml(html.match(/production-header__title[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const subtitle = stripHtml(
    html.match(/production-header__subtitle-item[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "",
  );
  const composer = composerFromText(subtitle);
  if (!title || !composer || NON_OPERA.test(`${title} ${subtitle}`)) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseCredits(html);
  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/spielplan/${slug}/`,
    creative_team: creative,
    cast,
    performances,
  };
}

/** Each performance is a `<time class="date" datetime="YYYY-MM-DD HH:MM">` plus a
 *  `performance__location` venue (Krefeld and Mönchengladbach venues intermix). */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const art of html.split('class="performance ').slice(1)) {
    const dt = art.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})"/);
    if (!dt) continue;
    const [, date, time] = dt;
    if (!date || (window.since && date < window.since)) continue;
    const venue =
      stripHtml(art.match(/performance__location[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "") || null;
    const ticket = art.match(/href="(https:\/\/tickets\.theater-kr-mg\.de\/[^"]+)"/)?.[1] ?? null;
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    performances.push({
      date: date as IsoDate,
      time: time ?? null,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
      ticket_url: ticket,
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** Members sit in two divisions: "Leitung" (creative team) and "Besetzung" (sung
 *  cast). Each member-teaser is a name (`member-teaser__title`) + a label
 *  (`member-teaser__subtitle`). The division decides the kind, so a Leitung label
 *  that isn't in the German map is still kept as a creative function (verbatim),
 *  never mistaken for a sung role. */
function parseCredits(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];

  for (const section of html.split(/members__division-title/).slice(1)) {
    const heading = stripHtml(section.slice(0, section.indexOf("</")) ?? "");
    const isCast = /Besetzung/i.test(heading);
    if (!isCast && !/Leitung/i.test(heading)) continue;
    // The section runs to the next division-title (split boundary), so its
    // member-teasers belong to this division.
    for (const teaser of section.split("member-teaser__title").slice(1)) {
      const name = stripHtml(teaser.match(/>([\s\S]*?)<\/h3>/)?.[1] ?? "");
      const label = stripHtml(
        teaser.match(/member-teaser__subtitle[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "",
      );
      if (!name || !label) continue;
      if (isCast) {
        cast.push({ role: label, name });
      } else {
        const c = normalizeGermanCredit(label, name);
        creative.push(c.function ? c : { function: label, name });
      }
    }
  }
  return { cast, creative };
}
