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
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Semperoper Dresden (`spielplan-html` strategy).
 *
 * Server-rendered. `/spielplan.html` lists `ni-schedule-event` rows, each with
 * the category + title + composer, date/time, venue, and a link to the
 * production page `/spielplan/stuecke/stid/{slug}/{id}.html`. We group rows by
 * production id; the detail page gives the title (h1) and the creative team +
 * sung cast (`ni-cast-item-label` + `ni-cast-item-link`, German labels). The
 * schedule is a forward window, so deep history comes from Wikidata in backfill.
 */

const BASE = "https://www.semperoper.de";
const SCHEDULE = `${BASE}/spielplan.html`;
/** Semperoper Dresden (the building) on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q127097";

export async function scrapeSemperoperDresden(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const rows = parseSchedule(await fetchHtml(SCHEDULE, ctx));

  const byId = new Map<string, ScheduleRow[]>();
  for (const r of rows) {
    const list = byId.get(r.prodId);
    if (list) list.push(r);
    else byId.set(r.prodId, [r]);
  }

  const productions: RawProduction[] = [];
  for (const [, group] of byId) {
    try {
      const prod = await buildProduction(ctx, group, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`semperoper-dresden: production ${group[0]?.prodId} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("semperoper-dresden: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "semperoper-dresden", productions };
}

// ── Schedule rows ────────────────────────────────────────────────────────────

interface ScheduleRow {
  prodId: string;
  slug: string;
  date: IsoDate;
  time: string | null;
  venueRoom: string | null;
}

function parseSchedule(html: string): ScheduleRow[] {
  const out: ScheduleRow[] = [];
  const blocks = html.split(/class="row ni-schedule-event/).slice(1);
  for (const block of blocks) {
    const link = block.match(/\/spielplan\/stuecke\/stid\/([a-z0-9-]+)\/(\d+)\.html/i);
    const date = parseGermanDate(block);
    if (!link || !date) continue;
    out.push({
      prodId: link[2] ?? "",
      slug: link[1] ?? "",
      date,
      time: parseTime(block),
      venueRoom: textOf(block, /ni-event-venue[^>]*>([\s\S]*?)<\//),
    });
  }
  return out;
}

// ── Per-production detail page ──────────────────────────────────────────────

async function buildProduction(
  ctx: FetchContext,
  rows: ScheduleRow[],
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const first = rows[0];
  if (!first) return null;
  const today = new Date().toISOString().slice(0, 10);

  const performances: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (window.since && r.date < window.since) continue;
    const key = `${r.date}|${r.time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    performances.push({
      date: r.date,
      time: r.time,
      venue_room: r.venueRoom,
      status: r.date < today ? "past" : "scheduled",
    });
  }
  if (performances.length === 0) return null;
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  const html = await fetchHtml(
    `${BASE}/spielplan/stuecke/stid/${first.slug}/${first.prodId}.html`,
    ctx,
  );
  const { creative_team, cast } = parseCast(html);
  return {
    source_production_id: first.prodId,
    work_title: textOf(html, /<h1[^>]*>([\s\S]*?)<\/h1>/) ?? first.slug,
    composer_name: parseComposer(html),
    detail_url: `${BASE}/spielplan/stuecke/stid/${first.slug}/${first.prodId}.html`,
    creative_team,
    cast,
    performances,
  };
}

/** Cast/creative: `<li><span class="ni-cast-item-label …">Label</span>…<a>Name</a>`. */
function parseCast(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const li of html.matchAll(/<li>([\s\S]*?ni-cast-item-label[\s\S]*?)<\/li>/g)) {
    const block = li[1] ?? "";
    const label = textOf(block, /ni-cast-item-label[^>]*>([\s\S]*?)<\/span>/);
    if (!label) continue;
    for (const nameMatch of block.matchAll(/ni-cast-item-link[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/g)) {
      const name = stripHtml(nameMatch[1] ?? "");
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

/** The detail page prints the composer right under the title, e.g. "Georges Bizet". */
function parseComposer(html: string): string | null {
  const sub = textOf(html, /<h1[^>]*>[\s\S]*?<\/h1>\s*(?:<[^>]+>\s*)*([^<]{3,60})</);
  if (!sub || /\d{2}:\d{2}|Uhr|Premiere|Vorstellung/.test(sub)) return null;
  return sub.replace(/\s*\([^)]*\)\s*$/, "").trim() || null;
}

// ── German date / helpers ─────────────────────────────────────────────────────

const GERMAN_MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  märz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

function parseGermanDate(block: string): IsoDate | null {
  const m = block.match(/(\d{1,2})\.\s*([A-Za-zäöü]+)\s+(\d{4})/);
  const month = m ? GERMAN_MONTHS[(m[2] ?? "").toLowerCase()] : undefined;
  if (!m || !month) return null;
  return `${m[3]}-${month}-${(m[1] ?? "").padStart(2, "0")}` as IsoDate;
}

function parseTime(block: string): string | null {
  const m = block.match(/(\d{1,2})(?:[:.](\d{2}))?\s*Uhr/);
  if (!m) return null;
  return `${(m[1] ?? "").padStart(2, "0")}:${m[2] ?? "00"}`;
}

function textOf(html: string, re: RegExp): string | null {
  const g = html.match(re)?.[1];
  return g != null ? stripHtml(g) || null : null;
}
