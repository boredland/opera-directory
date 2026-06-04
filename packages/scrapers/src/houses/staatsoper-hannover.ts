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
 * Staatsoper Hannover (`json-api` strategy).
 *
 * Part of the multi-genre Staatstheater Hannover, on the same `cb-event`
 * framework as Deutsche Oper Berlin. The calendar app reads `/de_DE/event.json`
 * (paginated by `p`, filtered from `date_from`): every announced performance
 * with `IdEventCluster` (production key), `Title`, `ContentCategory`, `OpusInfo`
 * (the "… von Composer" line) and a structured `Ensemble` (creative + sung cast,
 * German role labels). Unlike DOB the calendar carries the full ensemble inline,
 * so no per-production detail fetch is needed for credits — but every row of a
 * cluster repeats the run's start date, so the individual performance dates come
 * from the detail page's `further-event` articles. Future-only → Wikidata
 * backfill for the deep archive. We keep only the opera categories.
 */

const BASE = "https://staatstheater-hannover.de";
const EVENT_API = `${BASE}/de_DE/event.json`;
/** Opera House Hannover on Wikidata — see data/houses.json (the building entity
 *  Q315705, which is what premiere-location statements point at). */
const WIKIDATA_QID = "Q315705";

/** This is a multi-genre Staatstheater; only these ContentCategory values are opera. */
const OPERA_CATEGORIES = new Set(["Oper", "Musiktheater"]);

const GERMAN_MONTHS: Record<string, string> = {
  Januar: "01",
  Februar: "02",
  März: "03",
  April: "04",
  Mai: "05",
  Juni: "06",
  Juli: "07",
  August: "08",
  September: "09",
  Oktober: "10",
  November: "11",
  Dezember: "12",
};

interface HannoverEnsembleRow {
  Role?: string;
  Names?: string;
}
interface HannoverEvent {
  IdEventCluster?: number;
  Title?: string;
  ContentCategory?: string;
  OpusInfo?: string;
  Slug?: string;
  Ensemble?: HannoverEnsembleRow[];
}
interface HannoverResponse {
  EventOverview?: HannoverEvent[];
  Pager?: { IsLastPage?: boolean };
}

export async function scrapeStaatsoperHannover(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const events = await fetchEvents(ctx);

  const byCluster = new Map<number, HannoverEvent[]>();
  for (const e of events) {
    if (e.IdEventCluster == null || !OPERA_CATEGORIES.has(e.ContentCategory ?? "")) continue;
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
      console.warn(`staatsoper-hannover: cluster ${group[0]?.IdEventCluster} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatsoper-hannover: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatsoper-hannover", productions };
}

/** Paginate event.json from today forward (`date_from` floors it). */
async function fetchEvents(ctx: FetchContext): Promise<HannoverEvent[]> {
  const today = new Date().toISOString().slice(0, 10);
  const base = `${EVENT_API}?current_language=&keyword=&status=&location=alle&category=alle&date_from=${today}&q=&query=`;
  const out: HannoverEvent[] = [];
  for (let p = 1; p <= 60; p++) {
    const res = await fetchJson<HannoverResponse>(`${base}&p=${p}`, ctx);
    out.push(...(res.EventOverview ?? []));
    if (res.Pager?.IsLastPage !== false) break;
  }
  return out;
}

async function buildProduction(
  ctx: FetchContext,
  group: HannoverEvent[],
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const meta = group.find((e) => e.Ensemble && e.Ensemble.length > 0) ?? group[0];
  if (!meta?.Title || !meta.Slug) return null;

  const detailPath = meta.Slug.split("&")[0] ?? meta.Slug;
  const detailUrl = `${BASE}${detailPath}`;

  const html = await fetchHtml(detailUrl, ctx);
  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  return {
    source_production_id: String(meta.IdEventCluster),
    work_title: meta.Title.trim(),
    composer_name: parseComposer(meta.OpusInfo),
    detail_url: detailUrl,
    // The API Ensemble carries clean sung roles but only the conductor of the
    // creative team — the full team (director, designers, …) is on the detail page.
    creative_team: parseCreativeTeam(html),
    cast: parseCast(meta.Ensemble ?? []),
    performances,
  };
}

/** OpusInfo reads "Komische Oper von Gioachino Rossini\nLibretto von …" — the
 *  composer is the name after the first line's "von" (drop the libretto line). */
function parseComposer(opusInfo?: string): string | null {
  if (!opusInfo) return null;
  const firstLine = stripHtml(opusInfo.split(/\r?\n|<br\s*\/?>/i)[0] ?? "");
  const m = firstLine.match(/\bvon\s+(.+)$/i);
  if (!m?.[1]) return null;
  return (
    m[1]
      .split(/\s+und\s+/i)[0]
      ?.replace(/,.*$/, "")
      .trim() || null
  );
}

/** Sung cast from the API Ensemble rows: { Role: "Figaro", Names: '<a class="tuser_name">…</a>' }.
 *  Keep only rows whose label is NOT a creative function (those are sung roles); the
 *  conductor lands in the creative team from the detail page. Empty-Role rows are the
 *  institutional chorus/orchestra entries — skipped. */
function parseCast(ensemble: HannoverEnsembleRow[]): RawCredit[] {
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const row of ensemble) {
    const label = (row.Role ?? "").trim();
    if (!label) continue;
    for (const nm of (row.Names ?? "").matchAll(/class="tuser_name"[^>]*>([\s\S]*?)<\/a>/g)) {
      const name = stripHtml(nm[1] ?? "")
        .replace(/[,;]+$/, "")
        .trim();
      const credit = normalizeGermanCredit(label, name);
      const key = `${label}|${name}`;
      if (!name || credit.function || seen.has(key)) continue;
      seen.add(key);
      cast.push(credit);
    }
  }
  return cast;
}

/** Full creative team from the detail page's `<span class="person-role">Label:</span>
 *  <span class="person-names"><a class="tuser_name">Name</a></span>` rows. The page
 *  lists the same people in per-night blocks (with a trailing colon) and one
 *  production-level block (without) — we keep only rows whose label maps to a known
 *  creative function (drops sung roles and house-specific revival-supervision labels),
 *  deduping the repeats. Ensemble members are linked (`<a class="tuser_name">`); guest
 *  creatives (common for upcoming-season productions) are plain text — handle both. */
function parseCreativeTeam(html: string): RawCredit[] {
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();
  const re =
    /<span class="person-role\s*">([^<]*)<\/span>\s*<span class="person-names">([\s\S]*?)<\/span>/g;
  for (const m of html.matchAll(re)) {
    const label = stripHtml(m[1] ?? "");
    const block = m[2] ?? "";
    if (!label) continue;
    const linked = [...block.matchAll(/class="tuser_name"[^>]*>([\s\S]*?)<\/a>/g)].map((x) => x[1]);
    const rawNames = linked.length > 0 ? linked : [block];
    for (const raw of rawNames) {
      const name = stripHtml(raw ?? "")
        .replace(/[,;]+$/, "")
        .trim();
      const credit = normalizeGermanCredit(label, name);
      const key = `${credit.function}|${name}`;
      if (!name || !credit.function || seen.has(key)) continue;
      seen.add(key);
      creative_team.push(credit);
    }
  }
  return creative_team;
}

/** `<article class="further-event" aria-label="Title Weekday, DD. Monat YYYY,
 *  HH:MM – HH:MM Uhr, Venue">` — one per announced performance. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<article class="further-event[^"]*"[^>]*aria-label="([^"]*)"/g)) {
    const label = stripHtml(m[1] ?? "");
    const dm = label.match(/(\d{1,2})\.\s+(\p{L}+)\s+(\d{4}),\s+(\d{1,2}:\d{2})/u);
    if (!dm) continue;
    const month = GERMAN_MONTHS[dm[2] ?? ""];
    if (!month) continue;
    const date = `${dm[3]}-${month}-${(dm[1] ?? "").padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = dm[4] ?? null;
    const venue = label.split(",").pop()?.trim() || null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}
