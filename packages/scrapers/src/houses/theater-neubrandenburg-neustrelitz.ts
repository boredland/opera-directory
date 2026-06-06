import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, fetchRendered, stripHtml } from "../fetch";
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
 * Theater und Orchester Neubrandenburg/Neustrelitz (`render` strategy) — a
 * two-city company in Mecklenburg playing in Neubrandenburg, Neustrelitz and the
 * open-air Schlossgarten Neustrelitz festival.
 *
 * WordPress (custom `projekte` post type). The musiktheater repertoire lists
 * statically on `/musiktheater/` as `/projekte/{slug}/` links — no render needed
 * for discovery. Each detail page is the production: `<h1>` title, a "{genre} von
 * {Composer}" subtitle right after it, an `<aside id="kredits">` Besetzung block
 * (sung cast as "Role: Name" rows, then a creative-team `<p>` of "Label: Name"),
 * and a `spielplan_filter` calendar of that production's own dated performances.
 * The calendar is injected client-side, so detail pages are read via
 * `fetchRendered`; each `spielplan_bloc` row carries date, time, the venue/town
 * line and a PREMIERE / "wenige Karten" status flag. Galas, concerts, musicals
 * and non-works are dropped via a genre blacklist + a required composer.
 * Future-only → Wikidata backfill.
 */

const BASE = "https://tog.de";
/** Theater und Orchester Neubrandenburg/Neustrelitz on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q15444405";

/** A staged opera/operetta declares one of these genres in its subtitle… */
const OPERA_GENRE = /oper|operette|singspiel|dramma|musikdrama|op[ée]ra|musiktheater/i;
/** …but NOT these (musicals, plays, dance, concerts, children/family revues, galas). */
const NON_OPERA =
  /musical|schauspiel|kom[öo]die|ballett|\btanz|konzert|gala|revue|liederabend|lesung|sinfonie|symphonie/i;

export async function scrapeTheaterNeubrandenburgNeustrelitz(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const list = await fetchHtml(`${BASE}/musiktheater/`, ctx);
    const slugs = [
      ...new Set(
        [...list.matchAll(/href="https:\/\/tog\.de\/projekte\/([a-z0-9-]+)\/?"/g)].map(
          ([, s]) => s ?? "",
        ),
      ),
    ].filter(Boolean);
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-neubrandenburg-neustrelitz: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-neubrandenburg-neustrelitz: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-neubrandenburg-neustrelitz: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-neubrandenburg-neustrelitz", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/projekte/${slug}/`;
  const html = await fetchRendered(url, ctx, { waitMs: 7000 });

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>([\s\S]{0,400})/);
  const title = stripHtml(titleMatch?.[1] ?? "");
  if (!title) return null;

  // The "{genre} von {Composer}" line sits in the <h2> right after the <h1>.
  const subtitle = stripHtml(titleMatch?.[2]?.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "");
  if (!OPERA_GENRE.test(subtitle) || NON_OPERA.test(`${slug} ${subtitle}`)) return null;
  const composer = composerFromText(subtitle);
  if (!composer) return null;

  const { creative_team, cast } = parseKredits(html);
  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team,
    cast,
    performances,
  };
}

/** `spielplan_bloc` rows: date (DD.MM.YYYY), time (HH:MM), a venue/town line, a
 *  PREMIERE / "wenige Karten" status flag and an Eventim ticket link. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const block of html.split(/<div class="[^"]*\bspielplan_bloc\b/).slice(1)) {
    const dm = block.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (!dm) continue;
    const date = `${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
    if (window.since && date < window.since) continue;

    const time = block.match(/>(\d{1,2}:\d{2})</)?.[1] ?? null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const venue =
      stripHtml(
        block.match(
          /<p class="fs16 text-center padding0" style="line-height: 24px;">([\s\S]*?)<\/p>/,
        )?.[1] ?? "",
      ) || null;

    performances.push({
      date,
      time,
      venue_room: venue,
      status: statusOf(block, date, today),
      ticket_url: block.match(/href="(https:\/\/[^"]*eventim-inhouse[^"]*)"/)?.[1] ?? null,
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

function statusOf(
  block: string,
  date: IsoDate,
  today: string,
): NonNullable<RawPerformance["status"]> {
  if (date < today) return "past";
  if (/wenige Karten|Restkarten/i.test(block)) return "few_left";
  if (/ausverkauft/i.test(block)) return "sold_out";
  return "scheduled";
}

/** The `<aside id="kredits">` Besetzung: sung cast as "Role: Name" rows (after a
 *  BESETZUNG heading), then a creative-team `<p>` of "Label: Name" with mapped
 *  German function labels. Names appear bare or wrapped in an `<a href=/person/>`;
 *  alternating casts join two names with " / ". Ensemble lines without a colon
 *  (chorus, orchestra) are skipped. */
function parseKredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const aside = html.match(/<aside id="kredits"[^>]*>([\s\S]*?)<\/aside>/)?.[1];
  if (!aside) return { creative_team, cast };

  const seen = new Set<string>();
  for (const rawLine of aside.split(/<br\s*\/?>|<\/p>\s*<p>/)) {
    const line = stripHtml(rawLine.replace(/<strong>[\s\S]*?<\/strong>/g, ""));
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const label = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!label || !value) continue;

    for (const name of value.split(/\s*\/\s*/)) {
      const cleaned = name.trim();
      if (!cleaned || seen.has(`${label}|${cleaned}`)) continue;
      seen.add(`${label}|${cleaned}`);
      const credit = normalizeGermanCredit(label, cleaned);
      if (credit.function) creative_team.push(credit);
      else cast.push({ role: label, name: cleaned });
    }
  }
  return { creative_team, cast };
}
