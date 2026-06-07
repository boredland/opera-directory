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
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * St. Galler Festspiele — St. Gallen/Switzerland (`spielplan-html`, FESTIVAL).
 *
 * The summer festival (~June–July) that closes Theater St. Gallen's season: one
 * big Festspieloper shown alternately as an open-air production on the Klosterhof
 * in front of the cathedral or in the Grosses Haus, framed by a play, a dance
 * piece and a concert series — only the opera is kept. The festival site
 * (stgaller-festspiele.ch) redirects into the house CMS
 * (konzertundtheater.ch/programm/stgaller-festspiele), so the live scrape sees
 * only the CURRENT edition; past editions come from Wikidata backfill.
 *
 * The festival landing page links one detail page per item under
 * `/programm/a-z/{slug}/`. Each carries a `<h2 class="productionhead__title">`
 * (work) and a `<div class="productionhead__maininfos"><div>{genre} von
 * {composer}</div></div>` line: "Oper von Giuseppe Verdi" yields the composer via
 * composerFromText, while "Schauspiel von …" / "Tanzstück … von …" yield none —
 * so the composer requirement doubles as the opera gate, dropping play/dance.
 *
 * Performances live in the cast accordion's day selector as
 * `<option value="{id}">DD.MM.YYYY HH:MM</option>` rows. Cast and crew are
 * `<div class="productioncastandcrew__item">Label: Name</div>` pairs split into a
 * "Leitung" (crew → German function labels via normalizeGermanCredit) and a
 * "Besetzung" (cast → sung roles) section. Venue is read from the page (the
 * Klosterhof / Grosses Haus token), not hardcoded, since it alternates yearly.
 */

const BASE = "https://www.konzertundtheater.ch";
const FESTIVAL_URL = `${BASE}/programm/stgaller-festspiele`;
/** St. Galler Festspiele on Wikidata — Q1351965 ("music festival"), verified via
 *  wbsearchentities. It carries no P4647/P272 production relations today, so
 *  backfill currently yields nothing; the QID rides along for when modelled. */
const WIKIDATA_QID = "Q1351965";

/** Festival venues, longest-first so "Grosses Haus" wins over a bare "Haus". */
const VENUES = ["Klosterhof", "Grosses Haus", "Lokremise", "Tonhalle", "Stadtpark"];

export async function scrapeStGallerFestspiele(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    for (const url of await productionUrls(ctx)) {
      try {
        const prod = await buildProduction(ctx, url, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`st-galler-festspiele: ${url} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("st-galler-festspiele: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("st-galler-festspiele: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "st-galler-festspiele", productions };
}

/** Every `/programm/a-z/{slug}/` detail URL linked from the festival landing page. */
async function productionUrls(ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(FESTIVAL_URL, ctx);
  const urls = new Set<string>();
  for (const [, slug] of html.matchAll(
    /href="https?:\/\/www\.konzertundtheater\.ch\/programm\/a-z\/([a-z0-9-]+)\/"/g,
  )) {
    if (slug) urls.add(`${BASE}/programm/a-z/${slug}/`);
  }
  return [...urls];
}

async function buildProduction(
  ctx: FetchContext,
  url: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(url, ctx);

  const title = stripHtml(
    html.match(/<h2 class="productionhead__title">([\s\S]*?)<\/h2>/)?.[1] ?? "",
  );
  const genreLine = stripHtml(
    html.match(/class="productionhead__maininfos">\s*<div>([\s\S]*?)<\/div>/)?.[1] ?? "",
  );
  // The line leads with the genre ("Oper von …", "Schauspiel von …", "Tanzstück …
  // von …"): keep only sung music-theatre and drop the festival's play/dance/concert.
  const composer = isOpera(genreLine) ? composerFromText(genreLine) : null;
  if (!title || !composer) return null;

  const performances = parsePerformances(html, venueOf(html), window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseCredits(html);
  return {
    source_production_id: new URL(url).pathname.split("/").filter(Boolean).pop() ?? url,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** The day selector lists every performance as `<option value="{id}">DD.MM.YYYY
 *  HH:MM</option>`; the leading value="0" "Standardbesetzung" row carries no date. */
function parsePerformances(
  html: string,
  venue: string | null,
  window: ScrapeWindow,
): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const [, dd, mm, yyyy, hh, min] of html.matchAll(
    /<option value="\d+">\s*(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})/g,
  )) {
    const date = `${yyyy}-${mm}-${dd}` as IsoDate;
    const time = `${(hh ?? "").padStart(2, "0")}:${min}`;
    const key = `${date}|${time}`;
    if ((window.since && date < window.since) || seen.has(key)) continue;
    seen.add(key);
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

/** Cast/crew rows `<div class="productioncastandcrew__item">Label: Name</div>`,
 *  split by the "Leitung" (crew) and "Besetzung" (cast) section headers: a Leitung
 *  label maps through normalizeGermanCredit, a Besetzung label is a sung role. */
function parseCredits(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const castStart = html.indexOf(">Besetzung<");

  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/productioncastandcrew__item">([\s\S]*?)<\/div>/g)) {
    const text = stripHtml(m[1] ?? "");
    // Split on the ": " separator, not a bare ":", so inclusive labels like
    // "Tänzer:innen" keep their inner colon ("Tänzer:innen: Name" → label/name).
    const pair = text.match(/^(.*?):\s+(.+)$/);
    const label = pair?.[1]?.trim();
    const name = pair?.[2]?.trim();
    if (!label || !name) continue;

    const inCast = castStart !== -1 && (m.index ?? 0) > castStart;
    const key = `${label}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (inCast) {
      cast.push({ role: label, name });
    } else {
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}

const OPERA_GENRE = /\b(Oper|Operette|Singspiel|Musiktheater|musikalische Kom(ö|oe)die)\b/i;

/** A sung music-theatre genre — the opera gate that drops Schauspiel/Tanz/Konzert. */
function isOpera(genreLine: string): boolean {
  return OPERA_GENRE.test(genreLine);
}

/** The festival venue named on the page (Klosterhof open-air / Grosses Haus / …). */
function venueOf(html: string): string | null {
  const text = decodeEntities(html);
  for (const venue of VENUES) {
    if (text.includes(venue)) return venue;
  }
  return null;
}
