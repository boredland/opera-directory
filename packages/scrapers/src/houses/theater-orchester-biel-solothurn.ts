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
 * Theater Orchester Biel Solothurn / TOBS! (`spielplan-html`, TYPO3, server-
 * rendered, no proxy) — a touring company playing opera/operetta, Schauspiel,
 * Tanz and Konzert across two cities (Biel/Bienne and Solothurn) plus guest
 * venues. The spielplan is German; the opera leg uses the German credit helpers.
 *
 * The genre-filtered listing `/spielplan/oper` lists exactly the music-theatre
 * productions (one `/spielplan/detail/{slug}` link each) — that *is* the
 * opera/operetta filter, so we drop Schauspiel/Tanz/Konzert simply by starting
 * there. Detail pages carry no JSON-LD: the `<h1>` is the title, the first
 * `event-teaser` line is the composer (the opera gate — a production with no
 * composer is dropped), credit rows pair a `<strong>` label with a `<a>`/text
 * name (TOBS only labels the two groups "Leitung" → creative team and
 * "Besetzung" → cast, so individual creative functions are unlabelled and kept
 * verbatim), and performances sit under `<h4>` venue headers (Stadttheater Biel
 * / Solothurn / Auswärtige Vorstellungen) as "Wd DD.MM.YY HH:MM" rows, touring
 * rows carrying their own venue link. Past seasons aren't published → Wikidata
 * backfill.
 */

const BASE = "https://www.tobs.ch";
const LISTING = `${BASE}/spielplan/oper`;
/** Theater Orchester Biel Solothurn on Wikidata — verified via wbsearchentities. */
const WIKIDATA_QID = "Q1254620";

export async function scrapeTheaterOrchesterBielSolothurn(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(LISTING, ctx);
    const slugs = new Set(
      [...index.matchAll(/href="\/spielplan\/detail\/([a-z0-9-]+)"/g)].map(([, s]) => s as string),
    );
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-orchester-biel-solothurn: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-orchester-biel-solothurn: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-orchester-biel-solothurn: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-orchester-biel-solothurn", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/spielplan/detail/${slug}`;
  const html = await fetchHtml(url, ctx);

  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const composer = parseComposer(html);
  if (!title || !composer) return null; // opera gate: require a composer

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null; // past-only or undated → leave to backfill

  const { cast, creative } = parseCredits(html);
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

/** The composer is the first `<div class="mb-4">` line of the `event-teaser`
 *  block; fall back to a "von …"/"Mit Musik von …" credit line for pasticcio /
 *  anthology teasers ("Echoes of Baroque Mit Musik von Händel, Vivaldi …"). */
function parseComposer(html: string): string | null {
  const teaser =
    html.match(/class="event-teaser[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? "";
  // Each teaser line sits in its own inner block; the first holds the composer,
  // later ones the subtitle/librettist ("Libretto von …", "Uraufführung").
  const first = stripHtml(teaser.match(/<div[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? teaser);
  // A single clean name (no clause keywords, no separators) is the composer as-is;
  // anything richer (a multi-author "A | B | C" or a "Mit Musik von …" anthology)
  // goes through the German parser, then a leading-name fallback.
  if (first && !/\bvon\b|\||,|;/i.test(first) && first.length <= 50) return first;
  return (
    composerFromText(stripHtml(teaser)) ?? (first ? (first.split(/\s*\|\s*/)[0] ?? null) : null)
  );
}

const GERMAN_DATE = /\b(?:Mo|Di|Mi|Do|Fr|Sa|So)\.?\s*(\d{2})\.(\d{2})\.(\d{2})\s*(\d{2}:\d{2})?/g;

/**
 * Performances live under `<h4>` venue headers (Stadttheater Biel/Solothurn,
 * Nebia, "Auswärtige Vorstellungen") after the `name="tickets"` anchor, as
 * "Wd DD.MM.YY HH:MM" rows. Touring rows carry their own venue `<a>`, so the
 * per-row venue (if present) wins over the section header. A `premiere`/`derniere`
 * badge tags the row but isn't a status.
 */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const datesSection = html.slice(Math.max(0, html.indexOf('name="tickets"')));
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  // Split on venue headers so each chunk's date rows inherit that venue.
  const chunks = datesSection.split(/<h4[^>]*class="two-col no-margin"[^>]*>/);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] ?? "";
    const sectionVenue = stripHtml(chunk.match(/^([\s\S]*?)<\/h4>/)?.[1] ?? "") || null;
    for (const m of chunk.matchAll(
      /<div class="flex justify-between[^"]*"[^>]*>([\s\S]*?)<\/div>/g,
    )) {
      const row = m[1] ?? "";
      const dm = GERMAN_DATE.exec(stripHtml(row));
      GERMAN_DATE.lastIndex = 0;
      if (!dm) continue;
      const date = `20${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
      const time = dm[4] ?? null;
      const key = `${date}|${time}`;
      if ((window.since && date < window.since) || seen.has(key)) continue;
      seen.add(key);
      // A touring row names its venue inline; otherwise inherit the section header.
      const rowVenue = stripHtml(row.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "") || null;
      performances.push({
        date,
        time,
        venue_room: rowVenue ?? sectionVenue,
        status: date < today ? "past" : "scheduled",
      });
    }
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/**
 * Credit rows pair `<strong>label</strong>` with a name (`<a>` or plain text).
 * TOBS prints two layouts: a sparse one that labels only the two *groups*
 * ("Leitung" → creative team, "Besetzung" → cast) and blanks the per-person rows
 * (Falstaff), and a dense one that labels every row individually (Zauberflöte:
 * "Tamino", "Inszenierung", …). One pass serves both: a label that maps in the
 * German credit map is a creative function; a "Besetzung" header flips
 * subsequent unlabelled rows to cast; any other non-empty label is a sung role.
 */
function parseCredits(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();
  let inCast = false;

  const rowRe =
    /<div class="flex-initial"><strong>([\s\S]*?)<\/strong><\/div>\s*<div class="flex-1[^"]*">\s*(?:<a[^>]*>([\s\S]*?)<\/a>|([\s\S]*?))\s*<\/div>/g;
  for (const [, rawLabel, linked, plain] of html.matchAll(rowRe)) {
    const label = stripHtml(rawLabel ?? "");
    const name = stripHtml(linked ?? plain ?? "");
    if (/^besetzung$/i.test(label)) inCast = true;
    if (!name || seen.has(`${label}|${name}`)) continue;
    seen.add(`${label}|${name}`);

    if (/^(leitung|besetzung)$/i.test(label)) {
      // A bare group header: route the person by which group we're in.
      (inCast ? cast : creative).push({ name });
      continue;
    }
    if (!label) {
      // Unlabelled continuation row: inherits the current group.
      (inCast ? cast : creative).push({ name });
      continue;
    }
    const credit = normalizeGermanCredit(label, name);
    (credit.function ? creative : cast).push(credit);
  }
  return { cast, creative };
}
