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
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Deutsche Oper Berlin (`json-api` strategy).
 *
 * The calendar is a JS app over a JSON endpoint, `/de_DE/event.json` (paginated
 * by `date`+`p`): every announced performance with `Title`, the production key
 * `IdEventCluster`, `DateDay/Month/Year` + `DateTime`, `ContentCategory`, and a
 * `DetailLink`. We group events by cluster; the detail page gives the composer
 * (in `event_detail_headline` as "Title Composer [dates]") and the creative team
 * + sung cast (`<li><div class="role">…</div>` with German labels). Future-only,
 * so deep history comes from Wikidata in backfill.
 */

const BASE = "https://www.deutscheoperberlin.de";
const EVENT_API = `${BASE}/de_DE/event.json`;
/** Deutsche Oper Berlin (the house) on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q637834";

interface DobEvent {
  Title?: string;
  IdEventCluster?: number;
  DetailLink?: string;
  DateDay?: string;
  DateMonth?: string;
  DateYear?: string;
  DateTime?: string;
  ContentCategory?: string;
}
interface DobResponse {
  EventOverview?: DobEvent[];
  Pager?: { IsLastPage?: boolean };
}

export async function scrapeDeutscheOperBerlin(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const events = await fetchEvents(ctx);

  const byCluster = new Map<number, DobEvent[]>();
  for (const e of events) {
    if (e.IdEventCluster == null) continue;
    const list = byCluster.get(e.IdEventCluster);
    if (list) list.push(e);
    else byCluster.set(e.IdEventCluster, [e]);
  }

  const productions: RawProduction[] = [];
  for (const [, group] of byCluster) {
    try {
      const prod = await buildProduction(ctx, group, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`deutsche-oper-berlin: cluster ${group[0]?.IdEventCluster} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("deutsche-oper-berlin: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "deutsche-oper-berlin", productions };
}

/** Paginate event.json from today forward (the `date` filter floors it). */
async function fetchEvents(ctx: FetchContext): Promise<DobEvent[]> {
  const now = new Date();
  const date = `${String(now.getUTCDate()).padStart(2, "0")}.${String(now.getUTCMonth() + 1).padStart(2, "0")}.${now.getUTCFullYear()}`;
  const base = `${EVENT_API}?search=&id_city_region_search=&category_system=from_file&category=&location=&status_type=&date=${date}`;
  const out: DobEvent[] = [];
  for (let p = 1; p <= 60; p++) {
    const res = await fetchJson<DobResponse>(`${base}&p=${p}`, ctx);
    out.push(...(res.EventOverview ?? []));
    if (res.Pager?.IsLastPage !== false) break;
  }
  return out;
}

async function buildProduction(
  ctx: FetchContext,
  events: DobEvent[],
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const first = events[0];
  if (!first?.DetailLink || !first.Title) return null;
  const today = new Date().toISOString().slice(0, 10);

  const performances: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.DateYear || !e.DateMonth || !e.DateDay) continue;
    const date = `${e.DateYear}-${e.DateMonth}-${e.DateDay}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = e.DateTime?.split("|")[1]?.trim() || null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    performances.push({ date, time, status: date < today ? "past" : "scheduled" });
  }
  if (performances.length === 0) return null;
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  const html = await fetchHtml(`${BASE}${first.DetailLink}`, ctx);
  const { creative_team, cast } = parseBesetzung(html);
  return {
    source_production_id: first.DetailLink.replace(/^\/de_DE\/calendar\//, "").replace(/\/$/, ""),
    work_title: first.Title,
    composer_name: parseComposer(html),
    detail_url: `${BASE}${first.DetailLink}`,
    creative_team,
    cast,
    performances,
  };
}

/** In `event_detail_headline`, the composer is the `<p>` after the `<h1>` title,
 *  e.g. "Benjamin Britten [1913 – 1976]" — drop the life-dates bracket. */
function parseComposer(html: string): string | null {
  const headline = html.match(/event_detail_headline[\s\S]*?<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/)?.[1];
  if (!headline) return null;
  return (
    stripHtml(headline)
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

/** `<li><div class="role">Label</div><div class="names">…<a|span>Name…</li>` */
function parseBesetzung(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const li of html.matchAll(
    /<li>\s*<div class="role">([\s\S]*?)<\/div>\s*<div class="names">([\s\S]*?)<\/li>/g,
  )) {
    const label = stripHtml(li[1] ?? "");
    if (!label) continue;
    for (const nm of (li[2] ?? "").matchAll(
      /<(?:a[^>]*class="[^"]*person-link"|span class="person-name")[^>]*>([\s\S]*?)<\/(?:a|span)>/g,
    )) {
      const name = stripHtml(nm[1] ?? "");
      const key = `${label}|${name}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative_team.push(credit);
      else cast.push(credit);
    }
  }
  return { creative_team, cast };
}
