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
 * Staatsoper Unter den Linden, Berlin (`spielplan-html` strategy).
 *
 * Server-rendered, so no API to reverse-engineer. The works index
 * `/de/spielplan/werke/{YYYY-YYYY}/` lists every production of a season as a link
 * to `/de/veranstaltungen/{slug}.{id}/`; that production page is authoritative:
 * the title (h1), composer ("Musik von …"), the `besetzung__item` list (creative
 * team + sung cast, German labels), and every performance date in prose
 * ("5. Juni 2026"). One fetch per production; the season index drives discovery.
 *
 * `ScrapeWindow`: incremental does the current + next season (and floors past
 * performances by `window.since`); backfill walks season indexes back to `since`.
 */

const BASE = "https://www.staatsoper-berlin.de";
const WERKE = `${BASE}/de/spielplan/werke`;
/** Berlin State Opera (the house) on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q312576";
const FIRST_SEASON = 1869;

export async function scrapeStaatsoperBerlin(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const prodUrls = new Set<string>();
  for (const season of seasonsToScrape(window)) {
    try {
      const html = await fetchHtml(`${WERKE}/${season}/`, ctx);
      for (const m of html.matchAll(/\/de\/veranstaltungen\/[a-z0-9-]+\.\d+\//gi)) {
        prodUrls.add(m[0]);
      }
    } catch (err) {
      console.warn(`staatsoper-berlin: season index ${season} failed:`, err);
    }
  }

  const productions: RawProduction[] = [];
  for (const path of prodUrls) {
    try {
      const prod = await buildProduction(ctx, path, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`staatsoper-berlin: production ${path} failed:`, err);
    }
  }

  // Deep historical premieres beyond the season indexes — Wikidata (backfill only).
  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatsoper-berlin: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatsoper-berlin", productions };
}

/** Season-start years → "YYYY-YYYY" index slugs (German seasons run Aug–Jul). */
function seasonsToScrape(window: ScrapeWindow): string[] {
  const now = new Date();
  const currentStart = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const from =
    window.mode === "backfill"
      ? window.since
        ? Number.parseInt(window.since.slice(0, 4), 10)
        : FIRST_SEASON
      : currentStart;
  const seasons: string[] = [];
  for (let y = from; y <= currentStart + 1; y++) seasons.push(`${y}-${y + 1}`);
  return seasons;
}

// ── Per-production detail page ──────────────────────────────────────────────

async function buildProduction(
  ctx: FetchContext,
  path: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}${path}`, ctx);
  const workTitle = textOf(html, /<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (!workTitle) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseBesetzung(html);
  const sourceId = path.replace(/^\/de\/veranstaltungen\//, "").replace(/\/$/, "");
  return {
    source_production_id: sourceId,
    work_title: workTitle,
    composer_name: parseComposer(html),
    detail_url: `${BASE}${path}`,
    creative_team,
    cast,
    performances,
  };
}

/** Performance dates are printed in prose as "5. Juni 2026"; collect + dedup them. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/(\d{1,2})\.\s*([A-Za-zäöü]+)\s+(\d{4})/g)) {
    const month = GERMAN_MONTHS[(m[2] ?? "").toLowerCase()];
    if (!month) continue;
    const date = `${m[3]}-${month}-${(m[1] ?? "").padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, status: date < today ? "past" : "scheduled" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** "… Musik von Carl Maria von Weber (1821) Text von …" → "Carl Maria von Weber". */
function parseComposer(html: string): string | null {
  const m = html.match(/Musik von\s+([^<]+?)(?:\s+Text von|\s*<|\.|$)/);
  if (!m?.[1]) return null;
  return (
    stripHtml(m[1])
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim() || null
  );
}

/**
 * The first `besetzung__liste` is the standing team + cast:
 * `<li class="besetzung__item"><span class="besetzung__rolle">Label:</span>
 *  <div class="besetzung__beteiligte-liste"><…-item><a>Name</a>…`. A German
 * creative label → creative_team; anything else is a sung role.
 */
function parseBesetzung(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const list = html.match(/<ul class="besetzung__liste[^"]*">([\s\S]*?)<\/ul>/)?.[1] ?? "";
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  for (const item of list.matchAll(/<li class="besetzung__item">([\s\S]*?)<\/li>/g)) {
    const block = item[1] ?? "";
    const label = textOf(block, /besetzung__rolle">([\s\S]*?)<\/span>/);
    if (!label) continue;
    for (const nameMatch of block.matchAll(
      /besetzung__beteiligte-liste-item[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/g,
    )) {
      const name = stripHtml(nameMatch[1] ?? "");
      if (!name) continue;
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative_team.push(credit);
      else cast.push(credit);
    }
  }
  return { creative_team, cast };
}

// ── helpers ─────────────────────────────────────────────────────────────────

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

function textOf(html: string, re: RegExp): string | null {
  const g = html.match(re)?.[1];
  return g != null ? stripHtml(g) || null : null;
}
