import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Bregenzer Festspiele — Bregenz/Austria (`spielplan-html`, FESTIVAL).
 *
 * The lake-stage opera festival "Spiel auf dem See" on Lake Constance (the
 * Seebühne open-air opera), plus opera in the Festspielhaus, the Theater am
 * Kornmarkt and the Werkstattbühne. Seasonal: one edition each summer (runs
 * ~July–August), the site empty otherwise — a live scrape sees only the CURRENT
 * edition. Past editions come from Wikidata backfill.
 *
 * Next.js front end over a Drupal backend; no JSON-LD. The opera/music-theatre
 * productions all live under `/de/musiktheater/{slug}`, enumerable from the
 * sitemap (the rest of the festival — concerts, Schauspiel, Musik & Poesie — sits
 * under other paths and is dropped). The list isn't genre-tagged, so each detail
 * page is fetched and kept only when it carries a composer (the `<h2>` under the
 * work `<h1>`), which drops anything mis-filed.
 *
 * Dates aren't in the SSR HTML — they ride in the React Server Components payload
 * (`self.__next_f.push([1,"…"])`), as the "Termine" accordion: one `<p>` per
 * (month, time), e.g. "Mi 22., Fr 24., … Fr 31. Juli 2026 – 21.15 Uhr" — each day
 * token expanded against that line's shared month/year/time. Venue is the
 * Spielort named in the PREMIERE infotext block (Seebühne / Festspielhaus /
 * Theater am Kornmarkt / Werkstattbühne). Creative team + cast are
 * `<p class="small">Label<br>…<strong>Name</strong></p>` blocks (German function
 * labels → creative; character labels → cast; alternating casts are comma-listed).
 */

const BASE = "https://bregenzerfestspiele.com";
/** Bregenzer Festspiele on Wikidata — verified via wbsearchentities ("music
 *  festival"); P4647/P272 list past lake-stage premieres (e.g. "Upload" 2021). */
const WIKIDATA_QID = "Q694891";

const MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  märz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

export async function scrapeBregenzerFestspiele(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    for (const url of await operaUrls(ctx)) {
      try {
        const prod = await buildProduction(ctx, url, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`bregenzer-festspiele: ${url} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("bregenzer-festspiele: scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("bregenzer-festspiele: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "bregenzer-festspiele", productions };
}

/** Every `/de/musiktheater/{slug}` detail URL from the sitemap (the opera leg). */
async function operaUrls(ctx: FetchContext): Promise<string[]> {
  const xml = await fetchHtml(`${BASE}/sitemap.xml`, ctx);
  const urls = new Set<string>();
  for (const [, loc] of xml.matchAll(
    /<loc>(https:\/\/bregenzerfestspiele\.com\/de\/musiktheater\/[^<]+)<\/loc>/g,
  )) {
    if (loc) urls.add(decodeEntities(loc.trim()));
  }
  return [...urls];
}

async function buildProduction(
  ctx: FetchContext,
  url: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(url, ctx);

  const head = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>\s*<h2[^>]*>([\s\S]*?)<\/h2>/);
  const title = stripHtml(head?.[1] ?? "");
  // The <h2> is the composer ("Giuseppe Verdi"), sometimes composer + librettist
  // ("Daníel Bjarnason, Royce Vavrek") — the composer is the first name.
  const composer =
    stripHtml(head?.[2] ?? "")
      .split(/,| und /)[0]
      ?.trim() || null;
  if (!title || !composer) return null;

  const rsc = decodeRsc(html);
  const venue = venueFromInfotext(rsc);
  const performances = parseTermine(rsc, venue, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseCredits(rsc);
  return {
    source_production_id: new URL(url).pathname.split("/").pop() ?? url,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** Concatenate the React-flight payload pushed across `self.__next_f` chunks and
 *  JSON-unescape it into the page's data string (Drupal fields, dates, credits). */
function decodeRsc(html: string): string {
  const pushes = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map(
    (m) => m[1],
  );
  if (pushes.length === 0) return "";
  try {
    return JSON.parse(`"${pushes.join("").replace(/\n/g, " ")}"`);
  } catch {
    return "";
  }
}

/** The Spielort named in the PREMIERE infotext, e.g.
 *  "<p>PREMIERE<br>22. Juli 2026 – 21.15 Uhr<br>Seebühne</p>". */
function venueFromInfotext(rsc: string): string | null {
  const block = rsc.match(/PREMIERE[\s\S]*?<\/p>/)?.[0];
  if (!block) return null;
  const lines = block
    .split(/<br\s*\/?>/i)
    .map((l) => stripHtml(l))
    .filter(Boolean);
  return lines[lines.length - 1] || null;
}

/** The "Termine" accordion: one `<p>` per (month, time), each listing day tokens
 *  ("Mi 22., Fr 24., … Fr 31. Juli 2026 – 21.15 Uhr"). Expand each day against the
 *  line's shared month/year/time; weekday prefixes are ignored. */
function parseTermine(rsc: string, venue: string | null, window: ScrapeWindow): RawPerformance[] {
  const end = rsc.indexOf('"titel":"Termine"');
  if (end === -1) return [];
  const start = rsc.lastIndexOf('"akkordeoninhalt"', end);
  const block = start === -1 ? "" : rsc.slice(start, end);

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const line of block.replace(/<br\s*\/?>/gi, "</p><p>").split(/<\/?p[^>]*>/)) {
    const text = stripHtml(line);
    const m = text.match(
      /(.+?)\s+(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(\d{4})\s*[–-]\s*(\d{1,2})[.:](\d{2})\s*Uhr/i,
    );
    if (!m) continue;
    const [, daysPart, monthName, year, hh, mm] = m;
    const month = MONTHS[(monthName ?? "").toLowerCase()];
    const time = `${(hh ?? "").padStart(2, "0")}:${mm}`;
    if (!month) continue;

    for (const dm of (daysPart ?? "").matchAll(/(\d{1,2})\./g)) {
      const date = isoFromParts(year ?? "", month, dm[1] ?? "");
      if (!date) continue;
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
  }

  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** Credit blocks: `<p class="small">Label<br>…<strong>Name</strong>…</p>`. A
 *  mapped German function label → creative team; a character label → sung cast.
 *  Alternating casts are comma-listed inside/across the `<strong>`s. */
function parseCredits(rsc: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();

  for (const m of rsc.matchAll(/<p class="small">([^<]+?)<br>([\s\S]*?)<\/p>/g)) {
    const label = stripHtml(m[1] ?? "");
    if (!label || /^(PREMIERE|DAUER|EINFÜHRUNG)/i.test(label)) continue;

    const names = (m[2] ?? "")
      .match(/<strong>([\s\S]*?)<\/strong>/g)
      ?.flatMap((s) => stripHtml(s).split(","))
      .map((n) => n.trim())
      .filter(Boolean);
    if (!names?.length) continue;

    for (const name of names) {
      if (seen.has(`${label}|${name}`)) continue;
      seen.add(`${label}|${name}`);
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}
