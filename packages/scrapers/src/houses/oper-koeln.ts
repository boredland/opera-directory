import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchJson } from "../fetch";
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
 * Oper Köln (`json-api` strategy).
 *
 * A Nuxt front end backed by a clean Django-REST JSON API — no HTML scraping.
 * `/de/api/events/` paginates every announced performance (today forward) with,
 * per event: the production id, composer (`writer`), `start`/`stage_obj`,
 * sold-out/cancelled flags, and `cast_objs` / `productionteam_objs` (each a
 * `role_obj.name` + `person_obj.name` — German labels, classified like the other
 * German houses). We group events by production. The API is future-only, so deep
 * history comes from Wikidata in backfill mode.
 */

const API = "https://www.oper.koeln/de/api";
/** Cologne Opera (the building) on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q869662";

interface KoelnPerson {
  name?: string;
}
interface KoelnCredit {
  role_obj?: { name?: string };
  person_obj?: KoelnPerson;
}
interface KoelnEvent {
  production?: number;
  production_slug?: { de?: string };
  title?: string;
  writer?: string;
  start?: string;
  stage_obj?: { name?: string };
  canceled?: boolean;
  is_soldout?: boolean;
  is_revival?: boolean;
  cast_objs?: KoelnCredit[];
  productionteam_objs?: KoelnCredit[];
}
interface Paged<T> {
  next: string | null;
  results: T[];
}

export async function scrapeOperKoeln(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const events = await fetchAll<KoelnEvent>(`${API}/events/`, ctx);

  const byProduction = new Map<number, KoelnEvent[]>();
  for (const e of events) {
    if (e.production == null) continue;
    const list = byProduction.get(e.production);
    if (list) list.push(e);
    else byProduction.set(e.production, [e]);
  }

  const productions: RawProduction[] = [];
  for (const [id, group] of byProduction) {
    const prod = buildProduction(id, group, window);
    if (prod) productions.push(prod);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("oper-koeln: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "oper-koeln", productions };
}

function buildProduction(
  id: number,
  events: KoelnEvent[],
  window: ScrapeWindow,
): RawProduction | null {
  const today = new Date().toISOString().slice(0, 10);
  const performances: RawPerformance[] = [];
  for (const e of events) {
    if (!e.start) continue;
    const date = e.start.slice(0, 10) as IsoDate;
    if (window.since && date < window.since) continue;
    performances.push({
      date,
      time: e.start.slice(11, 16) || null,
      venue_room: e.stage_obj?.name ?? null,
      status: e.canceled
        ? "cancelled"
        : e.is_soldout
          ? "sold_out"
          : date < today
            ? "past"
            : "scheduled",
    });
  }
  if (performances.length === 0) return null;
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  const richest = events.reduce((best, e) => (creditCount(e) > creditCount(best) ? e : best));
  const { creative_team, cast } = parseCredits(richest);

  return {
    source_production_id: richest.production_slug?.de ?? `koeln-${id}`,
    work_title: richest.title ?? "",
    composer_name: richest.writer ?? null,
    is_revival: richest.is_revival ?? false,
    detail_url: richest.production_slug?.de
      ? `https://www.oper.koeln/de/produktion/${richest.production_slug.de}/`
      : null,
    creative_team,
    cast,
    performances,
  };
}

function creditCount(e: KoelnEvent): number {
  return (e.cast_objs?.length ?? 0) + (e.productionteam_objs?.length ?? 0);
}

/** Both lists carry role+person; a German function label → creative, else a sung role. */
function parseCredits(e: KoelnEvent): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const c of [...(e.productionteam_objs ?? []), ...(e.cast_objs ?? [])]) {
    const label = c.role_obj?.name?.trim();
    const name = c.person_obj?.name?.trim();
    if (!label || !name) continue;
    const key = `${label}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative_team.push(credit);
    else cast.push(credit);
  }
  return { creative_team, cast };
}

/** Walk a DRF `next`-paginated list to the end. */
async function fetchAll<T>(url: string, ctx: FetchContext): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  while (next) {
    const page: Paged<T> = await fetchJson<Paged<T>>(next, ctx);
    out.push(...page.results);
    next = page.next;
  }
  return out;
}
