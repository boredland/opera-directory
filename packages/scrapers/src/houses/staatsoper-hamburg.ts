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
 * Staatsoper Hamburg (`spielplan-html` strategy) — die-hamburgische-staatsoper.de.
 *
 * Server-rendered. The detail page shows only the *next* date, so dates come from
 * the full calendar `/de/kalender`: each `<li class="event-entry">` has a
 * `data-href="/de/programm/{genre}/{id}-{slug}"` (the production) plus its
 * `event__date` / time / location. We group calendar entries by production, then
 * fetch each production's detail page once for the title (h1), composer
 * ("Komposition: …"), and creative team + cast (`production-infos__item` list).
 * Future-only → deep history from Wikidata in backfill.
 */

const BASE = "https://www.die-hamburgische-staatsoper.de";
/** Hamburg State Opera (the house) on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q705453";

export async function scrapeStaatsoperHamburg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const byPath = parseCalendar(await fetchHtml(`${BASE}/de/kalender`, ctx), window);

  const productions: RawProduction[] = [];
  for (const [path, performances] of byPath) {
    if (performances.length === 0) continue;
    try {
      const prod = await buildProduction(ctx, path, performances);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`staatsoper-hamburg: ${path} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatsoper-hamburg: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatsoper-hamburg", productions };
}

/** Calendar: one `<li class="event-entry">` per performance → group by production. */
function parseCalendar(html: string, window: ScrapeWindow): Map<string, RawPerformance[]> {
  const today = new Date().toISOString().slice(0, 10);
  const byPath = new Map<string, RawPerformance[]>();
  for (const chunk of html.split(/<li class="event-entry">/).slice(1)) {
    const path = chunk.match(/data-href="(\/de\/programm\/[a-z]+\/\d+-[a-z0-9-]+)"/)?.[1];
    if (!path) continue;
    const head = stripHtml(chunk.slice(0, 700));
    const dm = head.match(/(\d{1,2})\.(\d{1,2})\.(\d{2})\b/);
    if (!dm) continue;
    const date =
      `20${dm[3]}-${(dm[2] ?? "").padStart(2, "0")}-${(dm[1] ?? "").padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;
    const list = byPath.get(path) ?? byPath.set(path, []).get(path);
    const time = head.match(/\b(\d{1,2}:\d{2})\b/)?.[1] ?? null;
    list?.push({
      date,
      time,
      venue_room: textOf(chunk.slice(0, 900), /event__location"[^>]*>([\s\S]*?)<\/div>/),
      status: date < today ? "past" : "scheduled",
    });
  }
  return byPath;
}

async function buildProduction(
  ctx: FetchContext,
  path: string,
  performances: RawPerformance[],
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}${path}`, ctx);
  const workTitle = textOf(html, /<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (!workTitle) return null;

  const seen = new Set<string>();
  const deduped = performances
    .filter((p) => {
      const key = `${p.date}|${p.time ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));

  const { creative_team, cast } = parseInfos(html);
  return {
    source_production_id: path.replace(/^\/de\/programm\//, ""),
    work_title: workTitle,
    composer_name: parseComposer(html),
    detail_url: `${BASE}${path}`,
    creative_team,
    cast,
    performances: deduped,
  };
}

/** "… Komposition: Giuseppe Verdi Libretto: …" → "Giuseppe Verdi". */
function parseComposer(html: string): string | null {
  const m = stripHtml(html).match(/Komposition:\s*(.+?)\s*(?:Libretto|Text|nach\b|$)/);
  return m?.[1]?.trim() || null;
}

/** A "name" that is actually a date ("1.1.27", "13.12.26", "13.12.2026 /") — not a person. */
const DATE_LIKE_NAME = /^\s*\d{1,2}\.\d{1,2}\.\d{2,4}\b/;

/**
 * Creative team + sung cast share one list:
 * `<li class="production-infos__item"><div class="label">Label</div>
 *  <div class="content…">…<span>Name</span></div></li>`. German function labels
 * → creative team, everything else is a sung role.
 */
function parseInfos(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /production-infos__item[^>]*>\s*<div class="label">([\s\S]*?)<\/div>\s*<div class="content[^"]*">([\s\S]*?)<\/div>\s*<\/li>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    if (!label) continue;
    for (const nm of (m[2] ?? "").matchAll(/<span>([\s\S]*?)<\/span>/g)) {
      const name = stripHtml(nm[1] ?? "");
      const key = `${label}|${name}`;
      if (!name || DATE_LIKE_NAME.test(name) || seen.has(key)) continue;
      seen.add(key);
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative_team.push(credit);
      else cast.push(credit);
    }
  }
  return { creative_team, cast };
}

function textOf(html: string, re: RegExp): string | null {
  const g = html.match(re)?.[1];
  return g != null ? stripHtml(g) || null : null;
}
