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
 * Theater und Orchester Heidelberg (`spielplan-html`, fully server-rendered).
 *
 * The Musiktheater sparte page (/de/sparten/142-musiktheater) lists the season's
 * productions; each /de/produktionen/{id}-{slug} detail page carries the title,
 * an "{genre} von {Composer}" subtitle, `calendar-item` performances (date in the
 * aria-label as DD-MM-YYYY, time/venue in the info column) and `preview-pople-list`
 * credits. The sparte mixes in song recitals, a musical and a revue — dropped via
 * a genre blacklist + a required composer. NB the site only renders a ~2-month
 * rolling window (query params are ignored), so a production outside it shows zero
 * dates and is skipped; full-season coverage needs recurring runs. Wikidata
 * backfill covers history.
 */

const BASE = "https://www.theaterheidelberg.de";
/** Theater und Orchester Heidelberg on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415680";
/** Musiktheater-sparte entries that aren't opera/operetta. */
const NON_OPERA = /musical|liedsoiree|liederabend|comedy|kabarett|revue|gala/i;

export async function scrapeTheaterHeidelberg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(`${BASE}/de/sparten/142-musiktheater`, ctx);
    const paths = [...new Set(index.match(/\/de\/produktionen\/\d+-[a-z0-9-]+/g) ?? [])];
    for (const path of paths) {
      try {
        const prod = await buildProduction(ctx, path, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-heidelberg: ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-heidelberg: index failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-heidelberg: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-heidelberg", productions };
}

async function buildProduction(
  ctx: FetchContext,
  path: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}${path}`, ctx);
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const subtitle = stripHtml(
    html.match(/article-production__subtitle[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "",
  );
  const composer = composerFromText(subtitle);
  if (!title || !composer || NON_OPERA.test(`${title} ${subtitle}`)) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null; // outside the rendered window

  const { cast, creative } = parseCredits(html);
  return {
    source_production_id: path.replace("/de/produktionen/", ""),
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}${path}`,
    creative_team: creative,
    cast,
    performances,
  };
}

/** Each `calendar-item` carries the date in its aria-label ("… DD-MM-YYYY {title}")
 *  and, in the info column, a "{HH:MM} → {HH:MM} Uhr" time then the venue `<p>`. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const item of html.split('class="calendar-item"').slice(1)) {
    const dm = item.match(/aria-label="[^"]*?(\d{2})-(\d{2})-(\d{4})/);
    if (!dm) continue;
    const [, dd, mm, yyyy] = dm;
    const date = `${yyyy}-${mm}-${dd}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = item.match(/(\d{1,2}:\d{2})[^<]*Uhr/)?.[1] ?? null;
    if (seen.has(`${date}|${time ?? ""}`)) continue;
    seen.add(`${date}|${time ?? ""}`);
    const venue = stripHtml(item.match(/Uhr\s*<\/p>\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "") || null;
    const ticket =
      item.match(/href="(https:\/\/theaterheidelberg\.eventim-inhouse\.de\/[^"]+)"/)?.[1] ?? null;
    performances.push({
      date,
      time,
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

/** `preview-pople-list` blocks: a role label + one or more linked names. A label
 *  in the German credit map is a creative function, anything else a sung role. */
function parseCredits(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];

  // split() bounds each block to one role's content (label + its names).
  for (const block of html.split("preview-pople-list__role").slice(1)) {
    const label = stripHtml(block.match(/^[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
    if (!label) continue;
    for (const m of block.matchAll(/preview-person-list__name[^>]*>([\s\S]*?)<\/span>/g)) {
      // The linked name; bare-text names may trail a `preview-person-playtimes`
      // marker span, so cut at it.
      const raw = m[1] ?? "";
      const name = stripHtml(
        raw.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? raw.split("<span")[0] ?? raw,
      );
      if (!name) continue;
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push(credit);
    }
  }
  return { cast, creative };
}
