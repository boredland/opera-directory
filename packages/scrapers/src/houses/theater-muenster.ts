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
 * Theater Münster (`spielplan-html`, server-rendered behind a Vue wrapper, no proxy).
 *
 * `/spielplan/kalender?category=1&date={YYYY-MM}` renders one month of the
 * Musiktheater sparte as `div.tm-performance` rows (day number, time, venue,
 * `tm-performance__category`, and a `/produktionen/{slug}-{id}.html` link). We walk
 * the months forward from today so the year is unambiguous, building performances
 * from the calendar and grouping them by production id. Each production's detail
 * page gives the title (`tm-autoProductionTitleModule__headline`), an author line
 * ("Oper in drei Akten von {Composer}") and a `tm-person` grid whose
 * `tm-person__category` labels classify each person as creative team (German
 * function label) or sung cast (a role). The sparte also carries musicals and
 * galas; both are dropped (no composer, or genre "Musical"). Future/season-only →
 * Wikidata backfill.
 */

const BASE = "https://www.theater-muenster.com";
/** Theater Münster on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415904";
const MONTHS_AHEAD = 14;

interface CalendarRow {
  id: string;
  detailUrl: string;
  performance: RawPerformance;
}

export async function scrapeTheaterMuenster(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const byId = await walkCalendar(ctx, window);
    for (const rows of byId.values()) {
      try {
        const prod = await buildProduction(ctx, rows);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-muenster: ${rows[0]?.id} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-muenster: calendar failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-muenster: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-muenster", productions };
}

/** Walk the Musiktheater calendar forward from the current month, grouping the
 *  `tm-performance` rows into a production-id → rows map (year from the requested month). */
async function walkCalendar(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<Map<string, CalendarRow[]>> {
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map<string, CalendarRow[]>();
  const startMonth = today.slice(0, 7);

  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    const month = addMonths(startMonth, i);
    const html = await fetchHtml(`${BASE}/spielplan/kalender?category=1&date=${month}`, ctx);
    for (const row of parseCalendar(html, month, today, window)) {
      const rows = byId.get(row.id) ?? [];
      if (
        !rows.some(
          (r) =>
            r.performance.date === row.performance.date &&
            r.performance.time === row.performance.time,
        )
      )
        rows.push(row);
      byId.set(row.id, rows);
    }
  }
  return byId;
}

/** One `CalendarRow` per `div.tm-performance` whose category is Musiktheater. */
function parseCalendar(
  html: string,
  month: string,
  today: string,
  window: ScrapeWindow,
): CalendarRow[] {
  const rows: CalendarRow[] = [];
  for (const block of html.split('<div class="tm-performance"').slice(1)) {
    const category = stripHtml(
      block.match(/tm-performance__category">([\s\S]*?)<\/li>/)?.[1] ?? "",
    );
    if (!/musiktheater/i.test(category)) continue;

    const day = (block.match(/tm-performance__dayNumber">([\s\S]*?)<\/div>/)?.[1] ?? "").match(
      /(\d{1,2})\s*$/,
    )?.[1];
    const link = block.match(
      /tm-performance__productionName">\s*<a href="(\/produktionen\/[^"]*?-(\d+)\.html)"/,
    );
    if (!day || !link?.[1] || !link[2]) continue;

    const date = `${month}-${day.padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;

    const rawTime = block.match(/tm-performance__performanceTime">\s*([\d.:]+)\s*Uhr/)?.[1];
    const time = rawTime ? rawTime.replace(".", ":") : null;
    const venue =
      stripHtml(block.match(/tm-performance__location">([\s\S]*?)<\/div>/)?.[1] ?? "") || null;

    rows.push({
      id: link[2],
      detailUrl: `${BASE}${link[1]}`,
      performance: { date, time, venue_room: venue, status: date < today ? "past" : "scheduled" },
    });
  }
  return rows;
}

async function buildProduction(
  ctx: FetchContext,
  rows: CalendarRow[],
): Promise<RawProduction | null> {
  const first = rows[0];
  if (!first) return null;

  const html = await fetchHtml(first.detailUrl, ctx);
  const author = stripHtml(
    html.match(/tm-autoProductionTitleModule__author">([\s\S]*?)<\/div>/)?.[1] ?? "",
  );
  // Musiktheater also lists musicals and galas; keep operas/operettas with a composer.
  if (/\bmusical\b/i.test(author)) return null;
  const composer = composerFromText(author) ?? composerFromEnglish(author);
  if (!composer) return null;

  const title = stripHtml(
    html.match(/tm-autoProductionTitleModule__headline">([\s\S]*?)<\/h1>/)?.[1] ?? "",
  );
  if (!title) return null;

  const performances = [...rows.map((r) => r.performance)].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  const { cast, creative } = parsePeople(html);
  return {
    source_production_id: first.id,
    work_title: title,
    composer_name: composer,
    detail_url: first.detailUrl,
    creative_team: creative,
    cast,
    performances,
  };
}

/** `tm-person` cards: `tm-person__name` + a `tm-person__category` label that is
 *  either a German creative function (→ creative team) or a sung role (→ cast).
 *  Cards without a category are ensembles (chorus/orchestra) and are skipped. */
function parsePeople(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  for (const card of html.matchAll(/class="tm-person"[^>]*>([\s\S]*?)<\/a>/g)) {
    const seg = card[1] ?? "";
    const name = stripHtml(seg.match(/tm-person__name">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const label = stripHtml(seg.match(/tm-person__category">([\s\S]*?)<\/div>/)?.[1] ?? "");
    if (!name || !label) continue;
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative.push(credit);
    else cast.push(credit);
  }
  return { cast, creative };
}

/** Fallback for English author lines ("Opera in three acts by Benjamin Britten")
 *  that `composerFromText` (German "von") can't read. */
function composerFromEnglish(text: string): string | null {
  const name = text.match(/\bby\s+([A-ZÄÖÜ][^,(;]+)/)?.[1]?.trim();
  return name && name.length >= 3 && name.length <= 50 ? name : null;
}

/** Advance a "YYYY-MM" string by n months. */
function addMonths(yyyymm: string, n: number): string {
  const [y, m] = yyyymm.split("-").map(Number);
  const total = (y ?? 0) * 12 + (m ?? 1) - 1 + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}
