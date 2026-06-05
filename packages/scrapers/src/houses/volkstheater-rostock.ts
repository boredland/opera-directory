import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
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
 * Volkstheater Rostock (`spielplan-html` via a JSON callback; server-rendered).
 *
 * The spiritec-CMS spielplan is fed by `/callbacks/getschedule.json?filter=
 * musiktheater/&loadForwardFrom={YYYY-MM-01}`, which returns one month of
 * performance HTML per call (schema.org Microdata: `<meta itemprop="startDate">`
 * + a `/spielplan/monatsplan/musiktheater/{slug}/{perfId}/` link); we walk forward
 * a season's worth of months. The "musiktheater" sparte is MIXED (musical, dance,
 * song evenings), so each production's detail page is fetched and kept only when
 * its `production__author` reads "Oper/Operette … von {Composer}". The detail page
 * also gives the title (`<h1>`) and a `crew__item` creative team (no sung cast is
 * published). Future/season-only → Wikidata backfill.
 */

const BASE = "https://www.volkstheater-rostock.de";
/** Volkstheater Rostock on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1805969";
const MONTHS_AHEAD = 13;

interface ScheduleResponse {
  Schedule?: string;
}

export async function scrapeVolkstheaterRostock(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const bySlug = await walkSchedule(ctx, window);
    for (const [slug, perfs] of bySlug) {
      try {
        const prod = await buildProduction(ctx, slug, perfs);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`volkstheater-rostock: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("volkstheater-rostock: schedule failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("volkstheater-rostock: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "volkstheater-rostock", productions };
}

/** Walk the month-callback from the current month forward, grouping the Microdata
 *  Event blocks into a slug → performances map. */
async function walkSchedule(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<Map<string, RawPerformance[]>> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, RawPerformance[]>();
  const startMonth = today.slice(0, 7);

  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    const month = addMonths(startMonth, i);
    const url = `${BASE}/callbacks/getschedule.json?filter=musiktheater/&loadForwardFrom=${month}-01`;
    const res = await fetchJson<ScheduleResponse>(url, ctx);
    for (const block of (res.Schedule ?? "").split('itemtype="http://schema.org/Event"').slice(1)) {
      const m = block.match(/itemprop="startDate" content="(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      const slug = block.match(/\/spielplan\/monatsplan\/musiktheater\/([^/"]+)\//)?.[1];
      if (!m || !slug) continue;
      const date = m[1] as IsoDate;
      const time = m[2] ?? null;
      if (window.since && date < window.since) continue;
      const venue =
        stripHtml(block.match(/performance__location">([\s\S]*?)<\/div>/)?.[1] ?? "") || null;
      const perfs = bySlug.get(slug) ?? [];
      if (!perfs.some((p) => p.date === date && p.time === time)) {
        perfs.push({ date, time, venue_room: venue, status: date < today ? "past" : "scheduled" });
      }
      bySlug.set(slug, perfs);
    }
  }
  return bySlug;
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  perfs: RawPerformance[],
): Promise<RawProduction | null> {
  if (perfs.length === 0) return null;
  const url = `${BASE}/spielplan/monatsplan/musiktheater/${slug}/`;
  const html = await fetchHtml(url, ctx);
  const author = stripHtml(html.match(/production__author">([\s\S]*?)<\/div>/)?.[1] ?? "");
  const composer = composerFromText(author);
  // The "musiktheater" sparte mixes in musical/dance/song and themed song-evenings
  // ("Das Meer in Oper, Lied und Shanty"). Keep only opera/operetta with a composer.
  if (!composer || !/\boper(ette)?\b/i.test(author) || /musical|tanztheater|\btanz\b/i.test(author))
    return null;

  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!title) return null;
  perfs.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: parseCrew(html),
    performances: perfs,
  };
}

/** `crew__item` rows: `crew__role` label + `crew__names` people — all creative team. */
function parseCrew(html: string): RawCredit[] {
  const creative: RawCredit[] = [];
  for (const m of html.matchAll(
    /crew__role">([\s\S]*?)<\/div>\s*<div class="crew__names">([\s\S]*?)<\/div>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    const name = stripHtml(m[2] ?? "");
    if (!label || !name) continue;
    const credit = normalizeGermanCredit(label, name);
    creative.push(credit.function ? credit : { function: label, name });
  }
  return creative;
}

/** Advance a "YYYY-MM" string by n months. */
function addMonths(yyyymm: string, n: number): string {
  const [y, m] = yyyymm.split("-").map(Number);
  const total = (y ?? 0) * 12 + (m ?? 1) - 1 + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}
