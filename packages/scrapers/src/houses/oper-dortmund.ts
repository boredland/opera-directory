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
 * Oper Dortmund — the opera division of Theater Dortmund (`spielplan-html`).
 *
 * TYPO3, server-rendered. The shared `/kalender/` lists event tiles with an
 * `event__division` (genre — we keep "Oper") and a link
 * `/produktionen/detail/{slug}/`. Each detail page carries the composer in the
 * subtitle after the `<h1>` ("… von Composer"), the creative team as
 * `<strong>Label</strong> <a href="/ueber-uns/mitarbeiter-innen/biografie/…">Name</a>`
 * pairs, and every performance date as a "für DD.MM.YYYY" lightbox label (the
 * per-night cast itself is loaded by JS, so cast is left to nightly refresh /
 * other sources). Coverage is the calendar window; deep history via Wikidata.
 */

const BASE = "https://www.theaterdo.de";
/** Theater Dortmund on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q881014";

export async function scrapeOperDortmund(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const kalender = await fetchHtml(`${BASE}/kalender/`, ctx);
  const slugs = new Set<string>();
  for (const m of kalender.matchAll(
    /event__division">\s*([^<]*?)\s*<\/span>\s*<a href="\/produktionen\/detail\/([a-z0-9-]+)\/"/g,
  )) {
    if (m[1]?.trim() === "Oper" && m[2]) slugs.add(m[2]);
  }

  const productions: RawProduction[] = [];
  for (const slug of slugs) {
    try {
      const prod = await buildProduction(ctx, slug, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`oper-dortmund: ${slug} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("oper-dortmund: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "oper-dortmund", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/produktionen/detail/${slug}/`;
  const html = await fetchHtml(detailUrl, ctx);
  const workTitle = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!workTitle) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: parseComposer(html),
    detail_url: detailUrl,
    creative_team: parseCreative(html),
    cast: [],
    performances,
  };
}

/** Subtitle after the `<h1>`: "Musical von Sandra Engelhardt …" / "Oper von Verdi •". */
function parseComposer(html: string): string | null {
  const sub = stripHtml(html.match(/<\/h1>([\s\S]{0,400})/)?.[1] ?? "");
  const m = sub.match(/\bvon\s+([A-ZÄÖÜ][^•,<]{2,50})/);
  return m?.[1]?.split(/\s+und\s+/i)[0]?.trim() || null;
}

/** Creative team: `<strong>Label</strong> <a href="…/biografie/…">Name</a>` pairs. */
function parseCreative(html: string): RawCredit[] {
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<strong>([^<]+)<\/strong>\s*<a href="\/ueber-uns\/mitarbeiter-innen\/biografie\/[^"]*">([^<]+)<\/a>/g,
  )) {
    const credit = normalizeGermanCredit(stripHtml(m[1] ?? ""), stripHtml(m[2] ?? ""));
    if (!credit.function) continue; // only mapped functions; sung cast is JS-loaded
    const key = `${credit.function}|${credit.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creative_team.push(credit);
  }
  return creative_team;
}

/** Performance dates are "für DD.MM.YYYY" lightbox labels (no time published statically). */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/für (\d{2})\.(\d{2})\.(\d{4})/g)) {
    const date = `${m[3]}-${m[2]}-${m[1]}` as IsoDate;
    if (window.since && date < window.since) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, status: date < today ? "past" : "scheduled" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
