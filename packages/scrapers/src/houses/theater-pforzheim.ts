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
 * Theater Pforzheim (`spielplan-html`, TYPO3 + jweiland events2, server-rendered).
 *
 * The Musiktheater overview /spielplan/oper-und-operette.html lists one link per
 * production (a sentinel `eventDetail/1970-01-01_0100/{slug}.html`). The detail
 * page has the `<h1>` title, a "{genre} von {Composer}" `<h2 class="fontsize4">`,
 * the full date list in the "Alle Termine" accordion (`<dt>… DD.MM.YYYY</dt><dd>…
 * Beginn: HH:MM…</dd>`), a JSON-LD Event whose `location.name` is the venue, and a
 * free-text Besetzung block ("role <a><strong>NAME</strong></a>" rows). The
 * overview mixes in musicals/revues → dropped via the h2 genre + a required
 * composer. Text carries soft hyphens (U+00AD) — stripped. Past dates appear in
 * "Alle Termine" → status by date. Future/season → Wikidata backfill.
 */

const BASE = "https://www.theater-pforzheim.de";
/** Theater Pforzheim on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2328283";
const clean = (s: string): string => stripHtml(s).replace(/­/g, "").trim();

export async function scrapeTheaterPforzheim(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(`${BASE}/spielplan/oper-und-operette.html`, ctx);
    const links = [
      ...new Set(
        index.match(
          /\/veranstaltungen\/ansicht-veranstaltungen\/event\/eventDetail\/1970-01-01_0100\/[a-z0-9-]+\.html/g,
        ) ?? [],
      ),
    ];
    for (const path of links) {
      try {
        const prod = await buildProduction(ctx, path, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-pforzheim: ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-pforzheim: index failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-pforzheim: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-pforzheim", productions };
}

async function buildProduction(
  ctx: FetchContext,
  path: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}${path}`, ctx);
  const genre = clean(html.match(/fontsize4">([\s\S]*?)<\/h2>/)?.[1] ?? "");
  if (/\bmusical\b/i.test(genre)) return null; // drop musicals/revues
  // The "von {composer}" segment is the first of several "|"-separated clauses.
  const composer = composerFromText(genre.split("|")[0] ?? genre);
  const title = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!title || !composer) return null;

  const today = new Date().toISOString().slice(0, 10);
  const venue = html.match(/"location":\s*\{[^}]*?"name":\s*"([^"]+)"/)?.[1] ?? null;
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];
  for (const m of html.matchAll(
    /nth-child">\s*(?:[\wäöü.]+\.\s*)?(\d{2})\.(\d{2})\.(\d{4})\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g,
  )) {
    const date = `${m[3]}-${m[2]}-${m[1]}` as IsoDate;
    const time = m[4]?.match(/Beginn:\s*(\d{1,2}:\d{2})/)?.[1] ?? null;
    if ((window.since && date < window.since) || seen.has(`${date}|${time}`)) continue;
    seen.add(`${date}|${time}`);
    performances.push({
      date,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  if (performances.length === 0) return null;
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  const { cast, creative } = parseBesetzung(html);
  return {
    source_production_id:
      path
        .split("/")
        .pop()
        ?.replace(/\.html$/, "") ?? path,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}${path}`,
    creative_team: creative,
    cast,
    performances,
  };
}

/** Free-text Besetzung: "role/label <a><strong>NAME</strong></a>" rows (`<br>`-
 *  separated, "/"-joined alternating casts). A label in the German credit map is a
 *  creative function, anything else a sung role. */
function parseBesetzung(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const seg = html.match(/Besetzung<\/p>([\s\S]*?)(?:<\/div>|<h[23]|<\/article|$)/)?.[1] ?? "";
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];

  for (const line of seg.split(/<br\s*\/?>/)) {
    const names = [...line.matchAll(/<a[^>]*><strong>([^<]+)<\/strong><\/a>/g)].map((m) =>
      clean(m[1] ?? ""),
    );
    if (names.length === 0) continue;
    const label = clean(line.replace(/<a[\s\S]*$/, ""));
    if (!label) continue;
    for (const name of names) {
      if (!name) continue;
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}
