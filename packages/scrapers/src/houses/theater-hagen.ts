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
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Theater Hagen (`spielplan-html`, TYPO3, fully server-rendered).
 *
 * The Musiktheater sparte page lists every music-theatre production (current +
 * next season, split by the `#next-season` anchor) as `li.play-list-item` with a
 * title and a "{genre} von {Composer}" subtitle. Each `/veranstaltung/{slug}-{id}/
 * 0/show/Play/` detail page carries the dated `ul.termine-cards` (the YEAR is not
 * in the date text → derived from the season) and a `div.besetzung` of role/actor
 * pairs (German creative labels + sung roles). The sparte also holds musicals,
 * rock shows and staged song-cycles — filtered by genre, with a detail-page
 * fallback for an opera whose listing subtitle is composer-only (Cavalleria/
 * Pagliacci). Future/season-only → Wikidata backfill for history.
 */

const BASE = "https://www.theaterhagen.de";
const LISTING = `${BASE}/stueckekonzerte/theaterhagen/musiktheater/`;
/** Theater Hagen on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q546897";
/** Genres in the Musiktheater sparte that are not opera/operetta. */
const NON_OPERA = /musical|rock|pop|show|party|revue|gala|jazz/i;
const OPERA = /oper|operette|musiktheater/i;

interface ListItem {
  href: string;
  subtitle: string;
  seasonStart: number;
}

export async function scrapeTheaterHagen(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(LISTING, ctx);
    for (const item of parseListing(index)) {
      try {
        const prod = await buildProduction(ctx, item, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-hagen: ${item.href} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-hagen: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-hagen: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-hagen", productions };
}

/** Listing items before the `#next-season` anchor are the current season, after
 *  it the next. US-style: the season starting in autumn — months Aug–Dec sit in
 *  the start year, Jan–Jul in the next. */
function parseListing(html: string): ListItem[] {
  const nextSeasonPos = html.indexOf('id="next-season"');
  const today = new Date().toISOString().slice(0, 10);
  const curStart = Number.parseInt(today.slice(0, 4), 10) - (today.slice(5, 7) >= "08" ? 0 : 1);

  const items: ListItem[] = [];
  for (const m of html.matchAll(/<li class="play-list-item[^"]*">([\s\S]*?)<\/li>/g)) {
    const block = m[1] ?? "";
    const href = block.match(/href="(veranstaltung\/[^"]+)"/)?.[1];
    if (!href) continue;
    const subtitle = stripHtml(block.match(/subtitle">([\s\S]*?)<\/p>/)?.[1] ?? "");
    const genrePrefix = subtitle.split(/\s+von\s+/)[0] ?? subtitle;
    if (NON_OPERA.test(genrePrefix)) continue; // cheap drop: musical / rock / show

    const afterNext = nextSeasonPos >= 0 && (m.index ?? 0) > nextSeasonPos;
    items.push({ href, subtitle, seasonStart: afterNext ? curStart + 1 : curStart });
  }
  return items;
}

async function buildProduction(
  ctx: FetchContext,
  item: ListItem,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}/${item.href}`, ctx);
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const workInfo = stripHtml(html.match(/<\/h1>([\s\S]{0,400})/)?.[1] ?? "");

  // Opera if the listing subtitle says so, else confirm via the detail work-info
  // line (drops staged song-cycles / passions whose subtitle is a bare "von X").
  if (!OPERA.test(item.subtitle) && !OPERA.test(workInfo)) return null;
  if (!title) return null;

  // composerFromText handles "Oper von X"; a composer-only double-bill subtitle
  // ("Mascagni / Leoncavallo") has no "von" → take the first listed name.
  const composer =
    composerFromText(item.subtitle) ?? item.subtitle.split(/[/,]/)[0]?.trim() ?? null;

  const performances = parseTermine(html, item.seasonStart, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseBesetzung(html);
  return {
    source_production_id: item.href.replace(/\/0\/show\/Play\/$/, "").replace("veranstaltung/", ""),
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/${item.href}`,
    creative_team: creative,
    cast,
    performances,
  };
}

/** `ul.termine-cards` rows: `<h3> Sa. 13. 06. / 19:30 Uhr </h3>`, the venue on the
 *  bare text line after `</h3></a>` (after any "Einführung" note + `<br>`). */
function parseTermine(html: string, seasonStart: number, window: ScrapeWindow): RawPerformance[] {
  const cards = html.match(/<ul class="termine-cards">([\s\S]*?)<\/ul>/)?.[1] ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const li of cards.split("<li").slice(1)) {
    const m = li.match(
      /<h3>\s*[A-Za-zä]{2}\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*\/\s*(\d{1,2}:\d{2})\s*Uhr/,
    );
    if (!m) continue;
    const [, day, month, time] = m;
    const year = Number(month) >= 8 ? seasonStart : seasonStart + 1;
    const date = isoFromParts(year, month ?? "", day ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;
    if (seen.has(`${date}|${time}`)) continue;
    seen.add(`${date}|${time}`);

    const tail = li.match(/<\/h3><\/a>([\s\S]*?)<div class="more-infos"/)?.[1] ?? "";
    const venue = stripHtml(tail.split(/<br\s*\/?>/).pop() ?? "") || null;
    const ticket =
      li.match(/href="(https:\/\/theaterhagen\.eventim-inhouse\.de\/[^"]+)"/)?.[1] ?? null;
    performances.push({
      date,
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

/** `div.besetzung` lists `<span class="role">Label</span><span class="actor">Name</span>`;
 *  a label in the German credit map is a creative function, anything else a sung role. */
function parseBesetzung(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const block =
    html.match(/class="besetzung"([\s\S]*?)(?:<\/section>|<div class="more-infos)/)?.[1] ?? html;

  for (const m of block.matchAll(
    /<span class="role">([\s\S]*?)<\/span>\s*<span class="actor">([\s\S]*?)<\/span>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    const name = stripHtml(m[2] ?? "");
    if (!label || !name) continue;
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative.push(credit);
    else cast.push(credit);
  }
  return { cast, creative };
}
