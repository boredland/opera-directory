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
 * Badisches Staatstheater Karlsruhe (`spielplan-html` strategy).
 *
 * Server-rendered (the hyphenated host staatstheater-karlsruhe.de — the
 * staatstheater.karlsruhe.de subdomain hard-403s). The opera season list
 * `/programm/oper/spielplan/` links each production as `programm/info/{id}/`.
 * Detail page: `<h1>` title, an `<h2 class="h4">{genre} von {Composer}</h2>`
 * subtitle, a Besetzung `<table>` of `<tr><td><b>Label</b></td><td><a>Name</a></td></tr>`
 * rows (creative + sung cast, German labels), and a "Termine" section listing
 * `<b>{Weekday}, {DD.MM.}</b>, {HH:MM}` (no year — inferred from the page's
 * `jquery_calendar_start_date` season anchor). Future-only → Wikidata backfill.
 */

const BASE = "https://www.staatstheater-karlsruhe.de/";
/** Badisches Staatstheater Karlsruhe on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q552309";

/** Institutional "roles" (empty or ensemble) that are not an individual credit. */
const INSTITUTIONAL = /^(Badische Staatskapelle|Statisterie|Opernchor|Extrachor|Chor|Cantus)/i;

export async function scrapeBadischesStaatstheaterKarlsruhe(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const listing = await fetchHtml(`${BASE}programm/oper/spielplan/`, ctx);
  const ids = [...new Set((listing.match(/programm\/info\/(\d+)\//g) ?? []).map((m) => m))];

  const productions: RawProduction[] = [];
  for (const path of ids) {
    try {
      const prod = await buildProduction(ctx, path, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`badisches-staatstheater-karlsruhe: ${path} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("badisches-staatstheater-karlsruhe: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "badisches-staatstheater-karlsruhe", productions };
}

async function buildProduction(
  ctx: FetchContext,
  path: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}${path}`;
  const html = await fetchHtml(detailUrl, ctx);
  const workTitle = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!workTitle) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseBesetzung(html);
  return {
    source_production_id: path.match(/(\d+)/)?.[1] ?? path,
    work_title: workTitle,
    composer_name: parseComposer(html),
    detail_url: detailUrl,
    creative_team,
    cast,
    performances,
  };
}

/** Subtitle `<h2 class="h4">Melodramma in drei Akten von Giuseppe Verdi</h2>`. */
function parseComposer(html: string): string | null {
  const sub = stripHtml(html.match(/<h2 class="h4">([^<]*\bvon\b[^<]*)<\/h2>/)?.[1] ?? "");
  const m = sub.match(/\bvon\s+(.+)$/);
  return m?.[1]?.split(/\s+und\s+/i)[0]?.trim() || null;
}

/** Besetzung table: `<tr><td><b>Label</b></td><td>[<a>]Name[</a>]</td></tr>`. German
 *  function label → creative team, a character-role label → sung cast. */
function parseBesetzung(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<tr><td><b>([^<]*)<\/b><\/td><td>([\s\S]*?)<\/td><\/tr>/g)) {
    const label = stripHtml(m[1] ?? "");
    const name = stripHtml(m[2] ?? "")
      .replace(/\s*\([^)]*\)/g, "")
      .replace(/\*+$/, "")
      .trim();
    if (!label || !name || INSTITUTIONAL.test(name)) continue;
    const key = `${label}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative_team.push(credit);
    else cast.push(credit);
  }
  return { creative_team, cast };
}

/** Termine: `<b>{Weekday}, {DD.MM.}</b>, {HH:MM}`. The year is omitted, so it is
 *  inferred from the page's season anchor (`jquery_calendar_start_date`): the first
 *  year that places the date on/after the season start. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const seasonStart = html.match(/jquery_calendar_start_date\s*=\s*"(\d{4})-(\d{2})-(\d{2})"/);
  const startYear = seasonStart ? Number(seasonStart[1]) : new Date().getUTCFullYear();
  const startMd = seasonStart ? `${seasonStart[2]}-${seasonStart[3]}` : "01-01";
  const today = new Date().toISOString().slice(0, 10);

  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<b>[A-Za-zäöü]+,\s*(\d{1,2})\.(\d{1,2})\.<\/b>,?\s*(\d{1,2}:\d{2})/g,
  )) {
    const dd = (m[1] ?? "").padStart(2, "0");
    const mm = (m[2] ?? "").padStart(2, "0");
    // Season runs ~Aug→Jul: a month-day before the season start belongs to the next year.
    const year = `${mm}-${dd}` < startMd ? startYear + 1 : startYear;
    const date = `${year}-${mm}-${dd}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = m[3] ?? null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}
