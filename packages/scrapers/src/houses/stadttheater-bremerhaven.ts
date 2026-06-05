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
 * Stadttheater Bremerhaven (`spielplan-html`, TYPO3, server-rendered, no proxy).
 *
 * The sparte filter is a query param: `/spielplan/?kategorie=Musiktheater` returns
 * the whole opera season in one page (there's NO per-row sparte marker, and
 * combining `kategorie` with `monat` yields nothing). Each row links to a
 * `/{slug}/` detail page: `<h1>` title, an "{genre} von {Composer}" subtitle right
 * after it, dated `termin` blocks ("DD.MM.YYYY um HH:MM Uhr") and a `mitwirkende`
 * creative team (no singer→role cast is published). Venue comes from the listing
 * row ("HH:MM Uhr // {venue}"). Future/season-only → Wikidata backfill.
 */

const BASE = "https://stadttheaterbremerhaven.de";
/** Stadttheater Bremerhaven on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1355204";

export async function scrapeStadttheaterBremerhaven(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const list = await fetchHtml(`${BASE}/spielplan/?kategorie=Musiktheater`, ctx);
    const venues = slugVenues(list);
    for (const slug of [...venues.keys()]) {
      try {
        const prod = await buildProduction(ctx, slug, venues.get(slug) ?? null, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`stadttheater-bremerhaven: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("stadttheater-bremerhaven: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("stadttheater-bremerhaven: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "stadttheater-bremerhaven", productions };
}

/** Map each production slug (href on the filtered listing) to its venue, read from
 *  the row's "HH:MM Uhr // {venue}" line. Insertion order = listing order. */
function slugVenues(html: string): Map<string, string | null> {
  const venues = new Map<string, string | null>();
  for (const row of html.split(/class="termin/).slice(1)) {
    const slug = row.match(/<h3><a href="([^"]+)"/)?.[1];
    if (!slug || venues.has(slug)) continue;
    venues.set(slug, stripHtml(row.match(/Uhr\s*\/\/\s*([^<]+)</)?.[1] ?? "") || null);
  }
  return venues;
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  venue: string | null,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = slug.startsWith("http") ? slug : `${BASE}/${slug.replace(/^\//, "")}`;
  const html = await fetchHtml(url, ctx);
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  // The "{genre} von {composer}" subtitle sits in a csc-frame a little after the
  // <h1>, so take a generous window and let composerFromText find the "von".
  const subtitle = stripHtml(html.match(/<\/h1>([\s\S]{0,900})/)?.[1] ?? "");
  const composer = composerFromText(subtitle);
  if (!title || !composer) return null; // skip galas / works without a "von {composer}"

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];
  for (const m of html.matchAll(
    /class="datum">(\d{2})\.(\d{2})\.(\d{4})<\/span>\s*um\s*(\d{2}:\d{2})\s*Uhr/g,
  )) {
    const date = `${m[3]}-${m[2]}-${m[1]}` as IsoDate;
    const time = m[4] ?? null;
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

  return {
    source_production_id: slug.replace(/\/$/, "").split("/").pop() ?? slug,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: parseCreative(html),
    performances,
  };
}

/** `div.mitwirkende` lists `<strong>LABEL</strong> <a>Name</a>` pairs — all creative
 *  team (no sung cast here). Map known German labels; keep unknown labels verbatim. */
function parseCreative(html: string): RawCredit[] {
  const block =
    html.match(/class="mitwirkende"([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ??
    html.match(/class="mitwirkende"([\s\S]*?)<\/section>/)?.[1] ??
    "";
  const creative: RawCredit[] = [];
  for (const m of block.matchAll(/<strong>([\s\S]*?)<\/strong>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/g)) {
    const label = stripHtml(m[1] ?? "");
    const name = stripHtml(m[2] ?? "");
    if (!label || !name || /^N\.?\s*N\.?$/.test(name)) continue;
    const credit = normalizeGermanCredit(label, name);
    creative.push(credit.function ? credit : { function: label, name });
  }
  return creative;
}
