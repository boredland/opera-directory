import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchJson } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Opéra de Nice Côte d'Azur (`json-api` strategy). A WordPress house whose
 * programming is an `events` custom post type exposed over the open REST API —
 * and uniquely among the French houses, the production facts are fully
 * STRUCTURED in `acf`, so no detail-page HTML parsing is needed:
 *   - `acf.credits[]` is a `{ role, names }` list with a controlled vocabulary
 *     (`composer`, `musical-direction`/`music`, `stage-direction`, `choreography`,
 *     …) — `composer` is the opera gate, the rest map to creative functions;
 *   - `acf.event_dates[]` carries each night as `{ start_date: "YYYYMMDD",
 *     start_time: "HH:MM:SS" }`;
 *   - the `event_types` taxonomy gates genre — term 26 (fr "Opéra") / 158 (en) is
 *     the opera filter, applied server-side via `?event_types=`.
 *
 * Everything lives in the list response (`acf` is returned inline), so the whole
 * house is a single paginated REST sweep — no per-show fetch. Cast (singer→role)
 * is not published in a structured form, so cast is left empty (faithful).
 *
 * Use `www.opera-nice.org` — the `opera.nice.fr` host is unreachable from
 * datacenter IPs. Deep past comes from Wikidata (Q608423) in backfill mode.
 */

const BASE = "https://www.opera-nice.org";
const REST_EVENTS = `${BASE}/wp-json/wp/v2/events`;
const VENUE = "Opéra de Nice";
/** Opéra de Nice — verified via wbsearchentities: Q608423, P31 = opera house
 *  (Q153562), P17 = France (Q142). */
const WIKIDATA_QID = "Q608423";

/** `event_types` taxonomy term ids that mark a staged opera (fr "Opéra" + its en
 *  translation duplicate). Applied server-side as the genre gate. */
const OPERA_TERM_IDS = [26, 158];

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;
const PER_PAGE = 100;
const MAX_PAGES = 6;

/**
 * `acf.credits[].role` controlled vocabulary → canonical creative function.
 * `composer` is handled separately (it's the opera gate, not a creative credit).
 * Unknown roles are dropped rather than misfiled.
 */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  "musical-direction": "conductor",
  music: "conductor",
  conductor: "conductor",
  "stage-direction": "director",
  direction: "director",
  staging: "director",
  choreography: "choreographer",
  "chorus-master": "chorus-master",
  scenography: "set-designer",
  "set-design": "set-designer",
  costumes: "costume-designer",
  lighting: "lighting",
  dramaturgy: "dramaturgy",
};

interface NiceCredit {
  role?: string;
  names?: string;
}
interface NiceEventDate {
  start_date?: string;
  start_time?: string;
}
interface NiceEvent {
  slug?: string;
  link?: string;
  title?: { rendered?: string };
  event_types?: number[];
  acf?: { credits?: NiceCredit[]; event_dates?: NiceEventDate[] };
}

export async function scrapeOperaNiceCoteDAzur(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);
    for (const event of await fetchOperaEvents(ctx)) {
      const prod = buildProduction(event, since, today);
      if (prod) productions.push(prod);
    }
  } catch (err) {
    console.warn("opera-nice-cote-d-azur: events scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opera-nice-cote-d-azur: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "opera-nice-cote-d-azur", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** Every opera `events` row, server-side filtered to the opera taxonomy terms.
 *  `acf` rides along in the list payload, so one paginated sweep is the whole house. */
async function fetchOperaEvents(ctx: FetchContext): Promise<NiceEvent[]> {
  const terms = OPERA_TERM_IDS.join(",");
  const rows: NiceEvent[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let batch: NiceEvent[];
    try {
      batch = await fetchJson<NiceEvent[]>(
        `${REST_EVENTS}?event_types=${terms}&per_page=${PER_PAGE}&page=${page}&orderby=date&order=desc`,
        ctx,
      );
    } catch {
      // The endpoint 400s past the last page; stop quietly after page 1.
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return rows;
}

function buildProduction(
  event: NiceEvent,
  since: IsoDate | null,
  today: string,
): RawProduction | null {
  const credits = event.acf?.credits ?? [];
  const composer = pickComposer(credits);
  if (!composer) return null; // opera gate

  const title = decodeEntities(event.title?.rendered ?? "").trim();
  if (!title) return null;

  const performances = parsePerformances(event.acf?.event_dates ?? [], since, today);
  if (performances.length === 0) return null;

  const slug = event.slug ?? slugFromUrl(event.link ?? "");

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: event.link ?? null,
    creative_team: parseCreative(credits),
    cast: [],
    performances,
  };
}

/** The `composer`-role credit, decoded — the opera gate. */
function pickComposer(credits: NiceCredit[]): string | null {
  const raw = credits.find((c) => c.role === "composer")?.names;
  const name = raw ? decodeEntities(raw).trim() : "";
  return name || null;
}

/** Map the controlled credit vocabulary to creative functions, splitting the
 *  occasional co-credit ("A & B", "A et B", "A, B") into one row per person. */
function parseCreative(credits: NiceCredit[]): RawCredit[] {
  const out: RawCredit[] = [];
  for (const c of credits) {
    if (!c.role || c.role === "composer") continue;
    const fn = CREATIVE_FUNCTIONS[c.role];
    if (!fn || !c.names) continue;
    for (const name of splitNames(c.names)) out.push({ function: fn, name });
  }
  return out;
}

function splitNames(raw: string): string[] {
  return decodeEntities(raw)
    .split(/\s*(?:&|,| et )\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Structured `event_dates` → performances within the window. `start_date` is
 *  `YYYYMMDD`; `start_time` `HH:MM:SS` → `HH:MM` (null when absent). */
function parsePerformances(
  dates: NiceEventDate[],
  since: IsoDate | null,
  today: string,
): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const d of dates) {
    const m = d.start_date?.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) continue;
    const date = `${m[1]}-${m[2]}-${m[3]}` as IsoDate;
    if (since && date < since) continue;
    const time = d.start_time?.match(/^(\d{2}:\d{2})/)?.[1] ?? null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, venue_room: VENUE, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Opera season label from a date: Aug–Dec → "YYYY/YY+1", Jan–Jul → "YYYY-1/YY". */
function seasonOf(date?: IsoDate): string | null {
  if (!date) return null;
  const [y, m] = date.split("-").map(Number) as [number, number];
  const start = m >= 8 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}
