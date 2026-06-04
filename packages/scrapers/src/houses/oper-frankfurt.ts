import { type FetchContext, fetchHtml } from "../fetch";
import type { HouseScrapeResult, RawCredit, RawProduction } from "../types";

/**
 * WORKED EXAMPLE — Oper Frankfurt (`spielplan-html` strategy).
 *
 * This is the reference adapter the rest should be modeled on. It is deliberately
 * partial: it shows the *shape* of a house adapter and the production-centric
 * grouping, but the byte-level HTML parsing is left as the implementer's task
 * (the museumsufer monorepo has a battle-tested oper-frankfurt event parser at
 * packages/scrapers/src/venues/oper-frankfurt.ts that you can port and then
 * regroup from flat events into productions).
 *
 * The two jobs every house adapter must do:
 *   1. FUTURE — parse the live Spielplan (`/de/spielplan/`) into upcoming
 *      performances, grouped by production.
 *   2. PAST — walk the Spielplanarchiv (`/de/spielplan/archiv/`) season by
 *      season for the historical backfill. This is where the "big dataset"
 *      comes from; do not skip it.
 *
 * Group performances under a production by (work_title + premiere_season): the
 * same show on 12 nights is ONE RawProduction with 12 RawPerformance rows, not
 * 12 productions. The detail page carries the creative team and cast once.
 */

const BASE = "https://oper-frankfurt.de";
const SPIELPLAN_URL = `${BASE}/de/spielplan/`;
const ARCHIV_URL = `${BASE}/de/spielplan/archiv/`;

export async function scrapeOperFrankfurt(ctx: FetchContext): Promise<HouseScrapeResult> {
  const upcoming = await scrapeSpielplan(ctx);
  const archive = await scrapeArchive(ctx);
  return {
    house_slug: "oper-frankfurt",
    productions: mergeBySeason([...upcoming, ...archive]),
  };
}

async function scrapeSpielplan(ctx: FetchContext): Promise<RawProduction[]> {
  const html = await fetchHtml(SPIELPLAN_URL, ctx);
  // TODO: port the date_available + repertoire-element parser from museumsufer,
  // then enrich each unique show slug's detail page for creative team + cast.
  void html;
  return [];
}

async function scrapeArchive(ctx: FetchContext): Promise<RawProduction[]> {
  // TODO: discover season links on ARCHIV_URL, fetch each, emit RawProductions
  // with status:"past" performances. Archive detail pages keep full casting.
  void ARCHIV_URL;
  void ctx;
  return [];
}

/** Detail pages print credits as a definition list; normalize the German labels. */
export function normalizeCredit(rawLabel: string, name: string): RawCredit {
  const fn = CREDIT_LABELS[rawLabel.trim().toLowerCase()] ?? null;
  return fn ? { function: fn, name } : { role: rawLabel.trim(), name };
}

const CREDIT_LABELS: Record<string, string> = {
  "musikalische leitung": "conductor",
  dirigent: "conductor",
  regie: "director",
  inszenierung: "director",
  bühne: "set-designer",
  bühnenbild: "set-designer",
  kostüme: "costume-designer",
  licht: "lighting",
  choreografie: "choreographer",
  dramaturgie: "dramaturgy",
  chor: "chorus-master",
};

/** Collapse rows that share work + premiere season into one production. */
function mergeBySeason(rows: RawProduction[]): RawProduction[] {
  const byKey = new Map<string, RawProduction>();
  for (const r of rows) {
    const key = `${r.work_title}|${r.premiere_season ?? ""}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.performances.push(...r.performances);
    } else {
      byKey.set(key, { ...r, performances: [...r.performances] });
    }
  }
  return [...byKey.values()];
}
