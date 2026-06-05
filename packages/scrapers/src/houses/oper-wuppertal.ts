import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Oper Wuppertal — the opera arm of the Wuppertaler Bühnen (`json-api`).
 *
 * The spielplan pages are an empty JS shell fed by a c4c.it "API Platform" /
 * Hydra backend (`api.wb.c4c.it`); we hit that directly. Branch 1 = Oper (2 =
 * Schauspiel, 6 = Tanztheater Pina Bausch — both excluded). One paged query gives
 * every future opera performance with its nested production (title + a "von
 * {Composer}" shortDescription), so we group by production without a second fetch.
 * The branch mixes a few non-works in (quiz show, film night, intro course, gala)
 * — those carry no composer, so requiring one filters them out. No cast/creative
 * is exposed anywhere → future-only, Wikidata backfill for history.
 */

const API = "https://api.wb.c4c.it/api";
/** Wuppertaler Bühnen on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2595154";
const OPERA_BRANCH = 1;

interface WupProduction {
  "@id"?: string;
  title?: string;
  shortDescription?: string;
}
interface WupPerformance {
  startDateTime?: string;
  location?: { title?: string } | null;
  ticketUrl?: string | null;
  production?: WupProduction | null;
}
interface HydraPage {
  "hydra:member"?: WupPerformance[];
  "hydra:totalItems"?: number;
}

export async function scrapeOperWuppertal(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    productions.push(...(await scrapeLive(ctx, window)));
  } catch (err) {
    console.warn("oper-wuppertal: live api failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("oper-wuppertal: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "oper-wuppertal", productions };
}

async function scrapeLive(ctx: FetchContext, window: ScrapeWindow): Promise<RawProduction[]> {
  const today = new Date().toISOString().slice(0, 10);
  const after = window.since ?? today;
  const byId = new Map<
    string,
    { title: string; composer: string | null; perfs: RawPerformance[] }
  >();

  for (let page = 1; page <= 30; page++) {
    const url =
      `${API}/performances?production.branch.id=${OPERA_BRANCH}` +
      `&startDateTime%5Bafter%5D=${after}&order%5BstartDateTime%5D=asc&page=${page}`;
    const data = await fetchJson<HydraPage>(url, ctx, "application/ld+json");
    const members = data["hydra:member"] ?? [];
    for (const perf of members) addPerformance(byId, perf, today);
    if (members.length < 30) break; // last page
  }

  const out: RawProduction[] = [];
  for (const [id, p] of byId) {
    // The opera branch carries a few non-works (quiz/film/gala) with no composer.
    if (p.composer === null || p.perfs.length === 0) continue;
    const slug = id.split("/").pop() ?? id;
    out.push({
      source_production_id: slug,
      work_title: p.title,
      composer_name: p.composer,
      detail_url: `https://www.oper-wuppertal.de/programm/detailansicht-produktion/${slug}`,
      performances: p.perfs.sort(
        (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
      ),
    });
  }
  return out;
}

function addPerformance(
  byId: Map<string, { title: string; composer: string | null; perfs: RawPerformance[] }>,
  perf: WupPerformance,
  today: string,
): void {
  const prod = perf.production;
  const start = perf.startDateTime;
  if (!prod?.["@id"] || !prod.title || !start) return;
  const [date, clock] = start.split("T");
  if (!date) return;

  let entry = byId.get(prod["@id"]);
  if (!entry) {
    entry = {
      title: prod.title.trim(),
      composer: composerFromText(stripHtml(prod.shortDescription ?? "")),
      perfs: [],
    };
    byId.set(prod["@id"], entry);
  }
  entry.perfs.push({
    date: date as IsoDate,
    time: clock ? clock.slice(0, 5) : null,
    venue_room: perf.location?.title?.trim() || null,
    status: date < today ? "past" : "scheduled",
    ticket_url: perf.ticketUrl ?? null,
  });
}
