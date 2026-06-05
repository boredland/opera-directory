import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Saarländisches Staatstheater, Saarbrücken (`spielplan-html`).
 *
 * TYPO3. The /produktionen index is a single server-rendered page that already
 * carries the whole spielplan, one card per production: the `<h2>` title, a
 * teaser "{genre} von {Composer}", the sparte + venue, and a collapsed
 * `#allEvents-{id}` block listing every upcoming performance as
 * `<span class="singleEventDate"><b>{Weekday}, {DD}. {Mon},</b> {HH:MM} Uhr</span>`
 * next to its eventim ticket link. So ONE fetch yields everything — we do NOT walk
 * the ~74 /detail/{slug} pages: a burst of those trips the site's anti-bot 403
 * rate-limit (even via the proxy's single residential IP), which is why this house
 * was parked.
 *
 * Opera filter: the teaser genre contains "Oper"/"Operette" (Musical/Schauspiel/
 * Ballett drop out). Performance dates carry no year — the block is upcoming-only,
 * so infer it (this year, or next if the day has already passed). Past seasons
 * aren't on the index → Wikidata backfill covers history.
 */

const BASE = "https://www.staatstheater.saarland";
/** Saarländisches Staatstheater on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q208805";

export async function scrapeSaarlaendischesStaatstheater(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    productions.push(...parseIndex(await fetchHtml(`${BASE}/produktionen`, ctx)));
  } catch (err) {
    console.warn("saarlaendisches-staatstheater: index failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("saarlaendisches-staatstheater: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "saarlaendisches-staatstheater", productions };
}

function parseIndex(html: string): RawProduction[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawProduction[] = [];

  for (const card of html.split('class="productionsListItem').slice(1)) {
    const slug = card.match(/\/detail\/([a-z0-9-]+)/)?.[1];
    const teaser = stripHtml(card.match(/productionshortTeaser">([^<]*)</)?.[1] ?? "");
    if (!slug || !/oper/i.test(teaser)) continue; // opera/operette only

    const title = stripHtml(card.match(/<h2[^>]*>([\s\S]*?)<(?:span|\/h2)/)?.[1] ?? "");
    const venue =
      stripHtml(card.match(/fa-map-marker-alt[\s\S]*?<b>([\s\S]*?)<\/b>/)?.[1] ?? "") || null;
    // `split` already bounds `card` to a single production's markup.
    const performances = parsePerformances(card, venue, today);
    if (!title || performances.length === 0) continue;

    out.push({
      source_production_id: slug,
      work_title: title,
      composer_name: composerFromText(teaser),
      detail_url: `${BASE}/detail/${slug}`,
      performances,
    });
  }
  return out;
}

/** Each `<div class="singleEvent…">` holds a "{Weekday}, {DD}. {Mon}," date, an
 *  "{HH:MM} Uhr" time, and an eventim ticket link. The list is upcoming-only and
 *  yearless, so the year is inferred relative to today. */
function parsePerformances(card: string, venue: string | null, today: string): RawPerformance[] {
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  // Split on the row <div> only — `class="singleEvent` alone would also split the
  // inner `class="singleEventDate"` span and strip the marker the date regex needs.
  for (const ev of card.split('<div class="singleEvent').slice(1)) {
    const dm = ev.match(/singleEventDate">\s*<b>([^<]*)<\/b>([^<]*)/);
    if (!dm) continue;
    const date = parseGermanDate(dm[1] ?? "", today);
    if (!date) continue;
    const time = dm[2]?.match(/(\d{1,2}):(\d{2})/);
    const ticket = ev.match(/href="([^"]+)"[^>]*class="ticketLink"/)?.[1] ?? null;

    const key = `${date}|${time?.[0] ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    performances.push({
      date,
      time: time ? `${time[1]?.padStart(2, "0")}:${time[2]}` : null,
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

const GERMAN_MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mär: "03",
  mrz: "03",
  apr: "04",
  mai: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  sept: "09",
  okt: "10",
  nov: "11",
  dez: "12",
};

/** "So., 07. Jun," → an ISO date. The index lists only upcoming dates without a
 *  year, so pick the current year unless the day has already passed (→ next year). */
function parseGermanDate(text: string, today: string): IsoDate | null {
  const m = text.match(/(\d{1,2})\.\s*([A-Za-zä]+)/);
  const month = m ? GERMAN_MONTHS[(m[2] ?? "").toLowerCase().replace(/\.$/, "")] : undefined;
  if (!m || !month) return null;
  const day = (m[1] ?? "").padStart(2, "0");
  const year = Number.parseInt(today.slice(0, 4), 10);
  const candidate = `${year}-${month}-${day}`;
  return (candidate >= today ? candidate : `${year + 1}-${month}-${day}`) as IsoDate;
}
