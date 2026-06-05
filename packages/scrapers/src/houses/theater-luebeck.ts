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
 * Theater Lübeck (`spielplan-html`, fully server-rendered, no proxy).
 *
 * The musiktheater sparte page IS the opera gate — `/start/musiktheater.html`
 * lists exactly the music-theatre productions as relative
 * `./produktionen/{slug}_{season}.html?m=90` links, so we collect those and
 * trust the listing rather than re-filtering on a genre word (composer subtitles
 * are freeform, e.g. "Eine musikalische Irrfahrt … von Knut Winkmann").
 *
 * Each detail page carries the `<h1 class="search-keywords">` title, a header
 * `<div class="fs-3">` with the freeform "{genre} von {Composer}" line right
 * after the h1 (scoped from the h1 onward — `fs-3` is reused elsewhere on the
 * page), `<div class="termin …">` blocks ("Wd DD/MM/YY · HH.MM Uhr" + venue +
 * optional Premiere marker) and a `<h2>Besetzung</h2>` section of
 * `<span class="fw-bold">LABEL</span><span><a>NAME</a></span>` rows. The creative
 * team and the singers share that row shape, so each row is classified via
 * `normalizeGermanCredit`: a mapped function → creative_team, otherwise the label
 * is a sung role → cast. Future-only repertoire → Wikidata backfill.
 */

const BASE = "https://www.theaterluebeck.de";
/** Theater Lübeck on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415873";

export async function scrapeTheaterLuebeck(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const listing = await fetchHtml(`${BASE}/start/musiktheater.html`, ctx);
    for (const slug of productionSlugs(listing)) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-luebeck: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-luebeck: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-luebeck: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-luebeck", productions };
}

/** `{slug}_{season}` ids from the musiktheater listing's relative detail links. */
function productionSlugs(html: string): string[] {
  const slugs = new Set<string>();
  for (const m of html.matchAll(/\.\/produktionen\/([a-z0-9-]+_[0-9-]+)\.html\?m=90/g)) {
    if (m[1]) slugs.add(m[1]);
  }
  return [...slugs];
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/produktionen/${slug}.html?m=90`;
  const html = await fetchHtml(url, ctx);

  const title = stripHtml(html.match(/<h1 class="search-keywords">([\s\S]*?)<\/h1>/)?.[1] ?? "");
  // Scope the genre/composer line to the header block after the h1 — `fs-3` is
  // reused lower on the page. The subtitle is freeform; we only require a composer.
  const header = html.slice(html.indexOf('<h1 class="search-keywords">'));
  const subtitle = stripHtml(header.match(/<div class="fs-3">([\s\S]*?)<\/div>/)?.[1] ?? "");
  const composer = composerFromText(subtitle);
  if (!title || !composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseBesetzung(html);
  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** `termin` blocks: a `fs-4` "Wd DD/MM/YY · HH.MM Uhr", a venue `<div>`, and an
 *  optional "Premiere" marker. 2-digit year → 20YY; `·` is `&middot;`; HH.MM → HH:MM. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const block of html.split(/<div class="termin[^"]*">/).slice(1)) {
    const dm = block.match(
      /<div class="fs-4">[^<]*?(\d{2})\/(\d{2})\/(\d{2})\s*&middot;\s*(\d{1,2})\.(\d{2})\s*Uhr/,
    );
    if (!dm) continue;
    const date = `20${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
    const time = `${dm[4]?.padStart(2, "0")}:${dm[5]}`;
    if ((window.since && date < window.since) || seen.has(`${date}|${time}`)) continue;
    seen.add(`${date}|${time}`);
    // The venue is the first plain `<div>` following the date line.
    const after = block.slice(dm.index ?? 0);
    const venue = stripHtml(after.match(/<\/div>\s*<div>([^<]+)<\/div>/)?.[1] ?? "").trim() || null;
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

/** `Besetzung` rows are `<span class="fw-bold">LABEL</span><span> … </span>` where
 *  the second span holds one or more names (linked `<a href="personen/…">` or
 *  plain text). The block ends at `<div id="belowCast">`, beyond which the page
 *  repeats the whole cast once per date — bounding there is what dedupes it. A row
 *  whose label maps to a creative function → creative_team; else LABEL is a role. */
function parseBesetzung(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];

  const start = html.indexOf("<h2>Besetzung</h2>");
  if (start === -1) return { cast, creative };
  const end = html.indexOf("belowCast", start);
  const section = html.slice(start, end === -1 ? undefined : end);

  for (const row of section.matchAll(
    /<span class="fw-bold">([^<]+)<\/span>\s*<span>([\s\S]*?)<\/span>/g,
  )) {
    const label = stripHtml(row[1] ?? "");
    const inner = row[2] ?? "";
    if (!label) continue;
    const links = [...inner.matchAll(/<a href="personen\/[^"]+">([^<]+)<\/a>/g)].map((m) =>
      stripHtml(m[1] ?? ""),
    );
    const names = links.length > 0 ? links : [stripHtml(inner)];
    for (const name of names) {
      if (!name) continue;
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}
