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
 * Theater für Niedersachsen (TfN), Hildesheim (`spielplan-html`, TYPO3
 * `tx_theatrefehi`, server-rendered, no proxy) — a touring Landestheater that
 * also plays guest venues across Lower Saxony (Neumünster, Emden, …).
 *
 * The season index /programm/ (redirects to /programm/programm-{YY}-{YY}) lists
 * one `.productionteaser` per production with the detail link
 * /programm/produktion/{slug}; its season-switcher exposes the other announced
 * seasons (we walk every /programm/programm-* link). Each detail page carries the
 * title in `.productionview-title-text`, a "{genre} von {Composer}" line in
 * `.productionview-teasersubline` (genre-filtered to Oper/Operette so concerts,
 * musicals, Schauspiel and "Musiktheater-Solo" cabarets drop out), `.eventcard`
 * blocks (`.eventcard-date` DD.MM.YY → 20YY, `.eventcard-time`, `.eventcard-location`
 * "City: Hall" — the touring venue), and `.mb-2` cast rows pairing a
 * `.production-casts-role` (German label → creative team, else a sung role with a
 * trailing "_" marker) with a `.production-casts-name`. The index teasers expose
 * no genre, so each opera is decided on its detail page. Detail pages only render
 * remaining (future) dates — past performances vanish — so history comes from
 * Wikidata backfill.
 */

const BASE = "https://tfn-online.de";
const INDEX = `${BASE}/programm/`;
/** Theater für Niedersachsen on Wikidata — verified P31 opera house, P131 Hildesheim. */
const WIKIDATA_QID = "Q1371061";
/** Only these genre prefixes are opera/operetta; everything else (concert,
 *  musical, Schauspiel, Tanz, "Musiktheater-Solo" cabaret) is dropped. */
const OPERA_GENRE = /^(?:oper|operette|musikdrama|singspiel)\b/i;

export async function scrapeTheaterFuerNiedersachsen(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const slugs = await discoverSlugs(ctx);
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-fuer-niedersachsen: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-fuer-niedersachsen: index failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-fuer-niedersachsen: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-fuer-niedersachsen", productions };
}

/** Walk the current season index plus every other season the switcher links to,
 *  collecting the distinct /programm/produktion/{slug} detail paths. */
async function discoverSlugs(ctx: FetchContext): Promise<string[]> {
  const index = await fetchHtml(INDEX, ctx);
  const seasonPaths = new Set<string>(
    [...index.matchAll(/href="(\/programm\/programm-[^"]+)"/g)].map((m) => m[1] ?? ""),
  );

  const slugs = new Set<string>();
  collectSlugs(index, slugs);
  for (const path of seasonPaths) {
    try {
      collectSlugs(await fetchHtml(`${BASE}${path}`, ctx), slugs);
    } catch (err) {
      console.warn(`theater-fuer-niedersachsen: season ${path} failed:`, err);
    }
  }
  return [...slugs];
}

function collectSlugs(html: string, into: Set<string>): void {
  for (const m of html.matchAll(/href="\/programm\/produktion\/([a-z0-9-]+)"/g)) {
    if (m[1]) into.add(m[1]);
  }
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/programm/produktion/${slug}`;
  const html = await fetchHtml(url, ctx);

  const genreLine = clean(
    html.match(/productionview-teasersubline[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "",
  );
  if (!OPERA_GENRE.test(genreLine)) return null;
  const composer = composerFromText(genreLine);
  const title = clean(html.match(/productionview-title-text[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
  if (!title || !composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseCasts(html);
  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    presentation_note: genreLine || null,
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** `.eventcard` blocks: a `.eventcard-date` (DD.MM.YY — 2-digit year → 20YY), a
 *  `.eventcard-time` (HH:MM) and a `.eventcard-location` "City: Hall" tour venue. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const card of html.split('class="eventcard text-white"').slice(1)) {
    const dmy = card.match(/eventcard-date">\s*(\d{2})\.(\d{2})\.(\d{2})/);
    if (!dmy) continue;
    const date = `20${dmy[3]}-${dmy[2]}-${dmy[1]}` as IsoDate;
    const time = card.match(/eventcard-time">\s*(\d{1,2}:\d{2})/)?.[1] ?? null;
    const key = `${date}|${time ?? ""}`;
    if ((window.since && date < window.since) || seen.has(key)) continue;
    seen.add(key);
    const venue =
      clean(card.match(/eventcard-location[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? "") || null;
    performances.push({
      date,
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

/** `.mb-2` rows pair a `.production-casts-role` label with a `.production-casts-name`
 *  (span or anchor). A label in the German credit map is a creative function; any
 *  other label is a sung role. Role labels carry a trailing "_" and names a trailing
 *  "/" / "*" cast-marker, both stripped. */
function parseCasts(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();
  const region = html.slice(html.indexOf("production-casts"));

  for (const block of region.match(/<div class="mb-2">[\s\S]*?<\/div>/g) ?? []) {
    const label = clean(
      block.match(/production-casts-role">([\s\S]*?)<\/span>/)?.[1] ?? "",
    ).replace(/\s*_\s*$/, "");
    if (!label) continue;
    for (const m of block.matchAll(/production-casts-name[^>]*>([\s\S]*?)<\/(?:span|a)>/g)) {
      const name = clean(m[1] ?? "").replace(/\s*[/*]\s*$/, "");
      if (!name || seen.has(`${label}|${name}`)) continue;
      seen.add(`${label}|${name}`);
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}

/** Titles wrap a leading fragment in `<i>…&hairsp;</i>` for a drop-cap effect
 *  ("<i>rig&hairsp;</i>oletto"); naively stripping the tag inserts a space mid-word.
 *  Drop the typographic entities and the inline styling tags WITHOUT a separator
 *  first, then run the normal tag/entity strip. */
function clean(s: string): string {
  return stripHtml(
    s
      .replace(/&hairsp;|&#8202;| /g, "")
      .replace(/&shy;|­/g, "")
      .replace(/<\/?i\b[^>]*>/g, ""),
  );
}
