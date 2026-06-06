import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchJson, proxyFetch, stripHtml } from "../fetch";
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
 * Salzburger Festspiele / Salzburg Festival (`json-api` strategy).
 *
 * FESTIVAL — a major mixed-arts summer festival (plus a small Whitsun/Pfingsten
 * edition) with a large OPER strand; empty most of the year, so a live scrape is
 * the CURRENT edition's opera programme + Wikidata backfill for the deep archive.
 *
 * The /karten/programm spielplan is a Vue SPA over a JSON API at
 * `/vue/calendar/{lang}/…` (POST). Three endpoints drive it:
 *   - POST /de/programmes  → every production ever, grouped by type ("OPER",
 *     "KONZERT", "SCHAUSPIEL", …); each carries title, composer (`header` +
 *     `headerEntities`), `location` (venue), `first_event`/`last_event`,
 *     `event_count` and `id` (= arrangement_id). We keep the "OPER" group ONLY,
 *     dropping all concerts, drama (incl. "Jedermann") and sacred-concert strands.
 *   - POST /de/events      → every performance in the live window (Whitsun +
 *     summer of the current edition), with `arrangement_id` ↔ `programme_id`,
 *     UTC `start`, venue and a `control.button.type` availability flag.
 *   - GET  /de/programme/{arrangement_id}/{programme_id} → one production's
 *     `works` (composer = `author`), `cast.leading_team` (German credit labels)
 *     and `cast.cast` (role → singer).
 *
 * Live leg: drive off /de/events — its OPER arrangements ARE the current edition.
 * For each, fetch the detail for composer + cast + creative team. Backfill leg:
 * walk the full /de/programmes OPER list (back to 1920) using `first_event` dates
 * (detail fetch is skipped at archive scale), then append Wikidata.
 *
 * Times are UTC in the API; the site renders them in Europe/Vienna — we convert
 * so the local date and HH:MM match what the box office shows.
 */

const BASE = "https://www.salzburgerfestspiele.at/vue/calendar/de";
/** Salzburg Festival on Wikidata — verified via wbsearchentities (alias
 *  "Salzburger Festspiele", "music festival"). */
const WIKIDATA_QID = "Q256443";

interface ProgrammeListItem {
  id?: number;
  type?: string;
  title?: string;
  header?: string;
  location?: string;
  first_event?: string | null;
  last_event?: string | null;
  headerEntities?: { full_name?: string; credit_type_id?: number }[];
}

interface ProgrammeGroup {
  type?: string;
  programmes?: ProgrammeListItem[];
}

interface EventItem {
  arrangement_id?: number;
  programme_id?: number;
  type?: string;
  title?: string;
  header?: string;
  start?: string;
  location?: unknown;
  venue?: unknown;
  premiere?: boolean;
  rehearsal?: boolean;
  control?: { button?: { type?: string } };
}

interface CreditRow {
  name?: string;
  role?: string;
}

interface ProgrammeDetail {
  works?: { author?: string; title?: string }[];
  cast?: {
    leading_team?: CreditRow[];
    cast?: CreditRow[];
  };
}

export async function scrapeSalzburgerFestspiele(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const operByArrangement = await fetchOperProgrammes(ctx);
    const liveProductions = await buildLiveProductions(ctx, operByArrangement, window);
    productions.push(...liveProductions.productions);

    if (window.mode === "backfill") {
      productions.push(
        ...buildArchiveProductions(operByArrangement, liveProductions.seenArrangements, window),
      );
    }
  } catch (err) {
    console.warn("salzburger-festspiele: scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("salzburger-festspiele: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "salzburger-festspiele", productions };
}

/** POST /de/programmes (empty filter) → the "OPER" group only, keyed by arrangement id. */
async function fetchOperProgrammes(ctx: FetchContext): Promise<Map<number, ProgrammeListItem>> {
  const groups = await postJson<ProgrammeGroup[]>(`${BASE}/programmes`, {}, ctx);
  const byId = new Map<number, ProgrammeListItem>();
  for (const g of groups) {
    if (g.type !== "OPER") continue;
    for (const p of g.programmes ?? []) {
      if (p.id != null) byId.set(p.id, p);
    }
  }
  return byId;
}

/**
 * The live edition: every OPER arrangement that has events in the current window.
 * Each gets its dates from /de/events and its composer + cast + creative team
 * from the per-production detail endpoint.
 */
async function buildLiveProductions(
  ctx: FetchContext,
  operByArrangement: Map<number, ProgrammeListItem>,
  window: ScrapeWindow,
): Promise<{ productions: RawProduction[]; seenArrangements: Set<number> }> {
  const events = await postJson<EventItem[]>(`${BASE}/events`, {}, ctx);

  const byArrangement = new Map<number, EventItem[]>();
  for (const e of events) {
    if (e.type !== "OPER" || e.arrangement_id == null || !e.start) continue;
    const list = byArrangement.get(e.arrangement_id) ?? [];
    list.push(e);
    byArrangement.set(e.arrangement_id, list);
  }

  const productions: RawProduction[] = [];
  const seenArrangements = new Set<number>();

  for (const [arrangementId, evs] of byArrangement) {
    seenArrangements.add(arrangementId);
    try {
      const prod = await buildLiveProduction(ctx, arrangementId, evs, operByArrangement, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`salzburger-festspiele: arrangement ${arrangementId} failed:`, err);
    }
  }

  return { productions, seenArrangements };
}

async function buildLiveProduction(
  ctx: FetchContext,
  arrangementId: number,
  events: EventItem[],
  operByArrangement: Map<number, ProgrammeListItem>,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const performances = buildPerformances(events, window);
  if (performances.length === 0) return null;

  const programmeId = events.find((e) => e.programme_id != null)?.programme_id ?? null;
  const listItem = operByArrangement.get(arrangementId);

  let composer = composerFromList(listItem);
  let creative_team: RawCredit[] = [];
  let cast: RawCredit[] = [];
  let workTitle = cleanTitle(listItem?.title ?? events[0]?.title ?? "");

  if (programmeId != null) {
    const detail = await fetchJson<ProgrammeDetail>(
      `${BASE}/programme/${arrangementId}/${programmeId}`,
      ctx,
    );
    composer = detail.works?.find((w) => w.author)?.author?.trim() || composer;
    const workTitleFromDetail = detail.works?.find((w) => w.title)?.title?.trim();
    if (workTitleFromDetail) workTitle = cleanTitle(workTitleFromDetail);
    creative_team = mapCreative(detail.cast?.leading_team ?? []);
    cast = mapCast(detail.cast?.cast ?? []);
  }

  if (!workTitle || !composer) return null;

  return {
    source_production_id: `arrangement:${arrangementId}`,
    work_title: workTitle,
    composer_name: composer,
    premiere_date: events.some((e) => e.premiere) ? performances[0]?.date : null,
    detail_url: detailUrl(listItem),
    creative_team,
    cast,
    performances,
  };
}

/** Backfill: the full OPER archive (back to 1920) as productions dated by their
 *  first/last event. Detail/cast isn't fetched at archive scale — Wikidata and
 *  the programmes metadata are the seed. Skips arrangements already emitted live. */
function buildArchiveProductions(
  operByArrangement: Map<number, ProgrammeListItem>,
  seenArrangements: Set<number>,
  window: ScrapeWindow,
): RawProduction[] {
  const today = new Date().toISOString().slice(0, 10);
  const productions: RawProduction[] = [];

  for (const [arrangementId, p] of operByArrangement) {
    if (seenArrangements.has(arrangementId)) continue;
    const composer = composerFromList(p);
    const title = cleanTitle(p.title ?? "");
    if (!title || !composer) continue;

    const first = viennaDate(p.first_event);
    const last = viennaDate(p.last_event);
    if (!first) continue;
    if (window.since && (last ?? first) < window.since) continue;

    const performances: RawPerformance[] = [];
    const seen = new Set<string>();
    for (const d of [first, last]) {
      if (d && !seen.has(d)) {
        seen.add(d);
        performances.push({ date: d, status: d < today ? "past" : "scheduled" });
      }
    }

    productions.push({
      source_production_id: `arrangement:${arrangementId}`,
      work_title: title,
      composer_name: composer,
      detail_url: detailUrl(p),
      performances,
    });
  }

  return productions;
}

/** Each event → a dated performance (UTC `start` rendered in Europe/Vienna). */
function buildPerformances(events: EventItem[], window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const e of events) {
    if (e.rehearsal) continue;
    const date = viennaDate(e.start);
    if (!date) continue;
    const time = viennaTime(e.start);
    const key = `${date}|${time ?? ""}`;
    if ((window.since && date < window.since) || seen.has(key)) continue;
    seen.add(key);
    performances.push({
      date,
      time,
      venue_room: asText(e.venue) ?? asText(e.location),
      status: statusOf(e, date, today),
    });
  }

  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function statusOf(e: EventItem, date: IsoDate, today: string): RawPerformance["status"] {
  if (date < today) return "past";
  const button = e.control?.button?.type;
  if (button === "EXPIRED") return "past";
  if (button === "UNAVAILABLE") return "sold_out";
  return "scheduled";
}

/** Leading-team rows → mapped creative credits (German labels). A combined label
 *  the German map doesn't know (e.g. "Regie / Choreografie") falls back verbatim. */
function mapCreative(rows: CreditRow[]): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const name = r.name?.trim();
    const label = r.role?.trim();
    if (!name || !label) continue;
    const credit = normalizeGermanCredit(label, name);
    const fn = credit.function ?? label;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(credit.function ? credit : { function: label, name });
  }
  return out;
}

function mapCast(rows: CreditRow[]): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const name = r.name?.trim();
    if (!name) continue;
    const role = r.role?.trim() || null;
    const key = `${role ?? ""}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name });
  }
  return out;
}

/** Composer from the programmes list: prefer the tagged headerEntity, else `header`. */
function composerFromList(p: ProgrammeListItem | undefined): string | null {
  if (!p) return null;
  const entity = p.headerEntities?.find((e) => e.full_name)?.full_name?.trim();
  return entity || p.header?.trim() || null;
}

/** Titles occasionally carry an edition-year prefix ("2026 Das Rheingold"). */
function cleanTitle(raw: string): string {
  return stripHtml(raw)
    .replace(/^\d{4}\s+/, "")
    .trim();
}

function detailUrl(p: ProgrammeListItem | undefined): string | null {
  const link = p && "link" in p ? (p as { link?: string }).link : null;
  return link?.trim() || null;
}

const VIENNA_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Vienna",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const VIENNA_TIME = new Intl.DateTimeFormat("de-AT", {
  timeZone: "Europe/Vienna",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** UTC ISO timestamp → "YYYY-MM-DD" in Europe/Vienna (handles CET/CEST). */
function viennaDate(iso: string | null | undefined): IsoDate | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return VIENNA_DATE.format(d) as IsoDate;
}

/** UTC ISO timestamp → "HH:MM" in Europe/Vienna. */
function viennaTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return VIENNA_TIME.format(d).replace(/^24:/, "00:");
}

async function postJson<T>(url: string, body: unknown, ctx: FetchContext): Promise<T> {
  const res = await proxyFetch(url, ctx.proxy, {
    method: "POST",
    headers: {
      "User-Agent": ctx.userAgent,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} → ${res.status}`);
  return (await res.json()) as T;
}
