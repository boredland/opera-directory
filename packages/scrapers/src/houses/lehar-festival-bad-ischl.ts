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
import { isoFromParts } from "./_dates";
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Lehár Festival Bad Ischl — the summer operetta festival in Bad Ischl, Austria
 * (`spielplan-html`, FESTIVAL). Operetta is in scope here.
 *
 * Seasonal: one edition each summer (~July–August), typically two-or-three
 * operettas plus matinees/concerts at the Kongress & TheaterHaus. The site
 * carries only the CURRENT edition, so a live scrape sees the current operettas;
 * the deep past comes from Wikidata backfill.
 *
 * WordPress (Yoast); productions are an `us_portfolio` custom type, enumerable
 * from `/us_portfolio-sitemap.xml` (the `/stuecke/{slug}/` detail pages). The
 * REST API doesn't expose the type, so each detail page is fetched and parsed.
 *
 * Opera gate: the `untertitel` custom field reads "Operette von {Composer}
 * <br> Libretto von …" for the staged operettas; `composerFromText` extracts the
 * composer and returns null for the matinees, symposium, exhibition and gala
 * concert (descriptive subtitles, no "von {Composer}") — those are dropped.
 *
 * Dates ride in a `tablepress` table, one row per performance ("Sa., 18.07." +
 * "19.30 Uhr"); the day cells carry no year, so it's taken from the `premiere`
 * custom field ("Samstag, 18.07.2026"). Venue is the `spielort` field. Creative
 * team + cast are `<p>Label<br>…<strong>Name</strong></p>` blocks inside the
 * "Leitung" (→ creative) and "Besetzung" (→ cast) tab sections (German function
 * labels → creative via normalizeGermanCredit, character labels → sung roles).
 */

const BASE = "https://www.leharfestival.at";
const SITEMAP_URL = `${BASE}/us_portfolio-sitemap.xml`;
/** Lehár Festival Bad Ischl on Wikidata — Q19971126 ("music festival in Bad
 *  Ischl, Austria"), verified via wbsearchentities (sole match for "Lehár
 *  Festival"). Carries no P4647/P272 production relations today, so backfill
 *  yields nothing yet; the QID rides along for when those facts get modelled. */
const WIKIDATA_QID = "Q19971126";

export async function scrapeLeharFestivalBadIschl(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    for (const url of await portfolioUrls(ctx)) {
      try {
        const prod = await buildProduction(ctx, url, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`lehar-festival-bad-ischl: ${url} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("lehar-festival-bad-ischl: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("lehar-festival-bad-ischl: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "lehar-festival-bad-ischl", productions };
}

/** Every `/stuecke/{slug}/` detail URL from the us_portfolio sitemap. */
async function portfolioUrls(ctx: FetchContext): Promise<string[]> {
  const xml = await fetchHtml(SITEMAP_URL, ctx);
  const urls = new Set<string>();
  for (const [, loc] of xml.matchAll(
    /<loc>(https:\/\/www\.leharfestival\.at\/stuecke\/[^<]+)<\/loc>/g,
  )) {
    if (loc) urls.add(loc.trim());
  }
  return [...urls];
}

async function buildProduction(
  ctx: FetchContext,
  url: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(url, ctx);

  const title = stripHtml(html.match(/<h1[^>]*entry-title[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const subtitle = stripHtml(customField(html, "untertitel") ?? "");
  const composer = subtitle ? composerFromText(subtitle) : null;
  if (!title || !composer) return null; // operetta/opera gate

  const premiere = stripHtml(customField(html, "premiere") ?? "");
  const year = premiere.match(/\b(\d{4})\b/)?.[1];
  if (!year) return null;

  const venue = stripHtml(customField(html, "spielort") ?? "") || null;
  const performances = parsePerformances(html, year, venue, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseCredits(html);
  return {
    source_production_id: new URL(url).pathname.split("/").filter(Boolean).pop() ?? url,
    work_title: title,
    composer_name: composer,
    premiere_date: parsePremiereDate(premiere),
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** A µoStudio `w-post-elm post_custom_field … {key} …` field's inner value. */
function customField(html: string, key: string): string | null {
  const re = new RegExp(
    `post_custom_field[^"]*\\b${key}\\b[^>]*>[\\s\\S]*?w-post-elm-value">([\\s\\S]*?)</span>`,
  );
  return html.match(re)?.[1] ?? null;
}

/** The tablepress spielplan: one `<tr>` per performance, day cell "Sa., 18.07."
 *  (no year) + time cell "19.30 Uhr". The year comes from the premiere field. */
function parsePerformances(
  html: string,
  year: string,
  venue: string | null,
  window: ScrapeWindow,
): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const [, day, timeCell, ticketCell] of html.matchAll(
    /<td class="column-1">([\s\S]*?)<\/td>\s*<td class="column-2">([\s\S]*?)<\/td>(?:\s*<td class="column-3">([\s\S]*?)<\/td>)?/g,
  )) {
    const dm = stripHtml(day ?? "").match(/(\d{1,2})\.(\d{1,2})\./);
    if (!dm) continue;
    const date = isoFromParts(year, dm[2] ?? "", dm[1] ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;

    const time = parseTime(timeCell ?? "");
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);

    performances.push({
      date,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
      ticket_url: (ticketCell ?? "").match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ?? null,
    });
  }

  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** "Samstag, 18.07.2026" → "2026-07-18". */
function parsePremiereDate(premiere: string): IsoDate | null {
  const m = premiere.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return isoFromParts(m[3] ?? "", m[2] ?? "", m[1] ?? "");
}

/** "19.30 Uhr" / "19:30" → "19:30". */
function parseTime(raw: string): string | null {
  const m = stripHtml(raw).match(/(\d{1,2})[.:](\d{2})/);
  return m ? `${(m[1] ?? "").padStart(2, "0")}:${m[2]}` : null;
}

/** Credit blocks `<p …>Label<br>…<strong>Name</strong>…</p>`, scoped to the
 *  "Leitung" (creative) and "Besetzung" (cast) tab sections. A mapped German
 *  function label → creative team; any other label → a sung role. */
function parseCredits(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();

  const collect = (section: string, into: "cast" | "creative") => {
    for (const [, label, body] of section.matchAll(/<p[^>]*>([^<]+?)<br\s*\/?>([\s\S]*?)<\/p>/g)) {
      const fnLabel = stripHtml(label ?? "");
      const name = stripHtml(body ?? "");
      if (!fnLabel || !name || /^N\.N\.?$/i.test(name)) continue;
      if (seen.has(`${into}|${fnLabel}|${name}`)) continue;
      seen.add(`${into}|${fnLabel}|${name}`);

      const credit = normalizeGermanCredit(fnLabel, name);
      if (into === "creative" && credit.function) creative.push(credit);
      else cast.push({ role: fnLabel, name });
    }
  };

  collect(sectionAfter(html, "Leitung"), "creative");
  collect(sectionAfter(html, "Besetzung"), "cast");
  return { cast, creative };
}

/** The HTML between a tab section's `<h3>{title}</h3>` and the next section title. */
function sectionAfter(html: string, title: string): string {
  const start = html.indexOf(`w-tabs-section-title">${title}</h3>`);
  if (start === -1) return "";
  const rest = html.slice(start + title.length);
  const next = rest.search(/w-tabs-section-title">/);
  return next === -1 ? rest : rest.slice(0, next);
}
