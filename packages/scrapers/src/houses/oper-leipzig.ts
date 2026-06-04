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
 * Oper Leipzig (`spielplan-html` strategy).
 *
 * Nuxt, but server-rendered (SSR), so plain fetch works. `/de/programm` lists
 * production links `/de/programm/{slug}/{id}`. Each detail page carries the
 * composer (an `<h4>` right before the `<h1>` title), the creative team + sung
 * cast as `<li><strong>Label</strong> … <a href="/de/ensemble/person/…">Name</a>`,
 * and performances as `event-item__subline--date` spans ("So. 07.06.2026 | 17:00
 * | Opernhaus"). Future-only → deep history from Wikidata in backfill.
 */

const BASE = "https://www.oper-leipzig.de";
/** Leipzig Opera House on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q267248";

export async function scrapeOperLeipzig(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const programm = await fetchHtml(`${BASE}/de/programm`, ctx);
  const paths = [...new Set(programm.match(/\/de\/programm\/[a-z0-9-]+\/\d+/g) ?? [])];

  const productions: RawProduction[] = [];
  for (const path of paths) {
    try {
      const prod = await buildProduction(ctx, path, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`oper-leipzig: ${path} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("oper-leipzig: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "oper-leipzig", productions };
}

async function buildProduction(
  ctx: FetchContext,
  path: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}${path}`, ctx);
  const workTitle =
    textOf(html, /<h1[^>]*class="[^"]*infos-title__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/) ??
    textOf(html, /<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (!workTitle) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseBesetzung(html);
  return {
    source_production_id: path.replace(/^\/de\/programm\//, ""),
    work_title: workTitle,
    composer_name: parseComposer(html),
    detail_url: `${BASE}${path}`,
    creative_team,
    cast,
    performances,
  };
}

/** Composer is the `<h4>` immediately before the title `<h1>` in `infos-title`. */
function parseComposer(html: string): string | null {
  const m = html.match(/<h4[^>]*>([\s\S]*?)<\/h4>\s*(?:<!---->\s*)*<h1/);
  return m?.[1] ? stripHtml(m[1]).trim() || null : null;
}

/** `<li><strong>Label</strong> … <a href="/de/ensemble/person/…">Name</a>` — German
 *  function label → creative team, anything else a sung role. */
function parseBesetzung(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const li of html.matchAll(/<li><strong>([\s\S]*?)<\/strong>([\s\S]*?)<\/li>/g)) {
    const block = li[2] ?? "";
    if (!/\/de\/ensemble\/person\//.test(block)) continue; // only credit rows link to people
    const label = stripHtml(li[1] ?? "");
    if (!label) continue;
    for (const nm of block.matchAll(/\/de\/ensemble\/person\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
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

/** `event-item__subline--date` spans: "Wd. DD.MM.YYYY | HH:MM | Venue". */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/event-item__subline--date[^>]*>([\s\S]*?)<\/span>/g)) {
    const text = stripHtml(m[1] ?? "");
    const dm = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!dm) continue;
    const date =
      `${dm[3]}-${(dm[2] ?? "").padStart(2, "0")}-${(dm[1] ?? "").padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = text.match(/(\d{1,2}:\d{2})/)?.[1] ?? null;
    const venue = text.split("|").pop()?.trim() || null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time,
      venue_room: venue && /\d/.test(venue) ? null : venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

function textOf(html: string, re: RegExp): string | null {
  const g = html.match(re)?.[1];
  return g != null ? stripHtml(g) || null : null;
}
