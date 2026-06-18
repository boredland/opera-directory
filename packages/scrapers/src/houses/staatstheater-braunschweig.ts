import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { isoFromParts } from "./_dates";
import { composerFromText } from "./_german-credits";

/**
 * Staatstheater Braunschweig (`spielplan-html` strategy).
 *
 * TYPO3, server-rendered. The Musiktheater section pages
 * `/programm/musiktheater/{premieren,repertoire}` link every opera as `/produktion/{slug}`.
 * Each detail page: title in a `title-large` element (the `<h1>`/`<title>` are generic),
 * composer in a "von Composer" subtitle, and performances as `production-eventlist-item`
 * blocks (`.production-eventlist-date` holds "Sa 22.08.2026" then a second one the time
 * "19:30"). Future-only → Wikidata backfill.
 */

const BASE = "https://staatstheater-braunschweig.de";
/** Staatstheater Braunschweig on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q884234";

export async function scrapeStaatstheaterBraunschweig(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  const slugs = new Set<string>();
  for (const section of ["premieren", "repertoire"]) {
    try {
      const index = await fetchHtml(`${BASE}/programm/musiktheater/${section}`, ctx);
      for (const m of index.matchAll(/\/produktion\/([a-z0-9-]+)/g)) if (m[1]) slugs.add(m[1]);
    } catch {
      /* section may not exist */
    }
  }

  for (const slug of slugs) {
    try {
      const prod = await buildProduction(ctx, slug, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`staatstheater-braunschweig: ${slug} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatstheater-braunschweig: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatstheater-braunschweig", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/produktion/${slug}`;
  const html = await fetchHtml(detailUrl, ctx);
  const workTitle = stripHtml(
    html.match(/production-title-large[\s\S]{0,40}?<h\d[^>]*>([\s\S]*?)<\/h\d>/)?.[1] ?? "",
  );
  if (!workTitle) return null;

  const composer = composerFromText(
    stripHtml(html.match(/\bvon\s+[A-ZÄÖÜ][\s\S]{0,70}/)?.[0] ?? ""),
  );

  // .production-eventlist-date items alternate "Wd DD.MM.YYYY" then "HH:MM".
  const items = [...html.matchAll(/production-eventlist-date[^>]*>([\s\S]*?)<\/div>/g)].map((m) =>
    stripHtml(m[1] ?? ""),
  );
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];
  for (let i = 0; i < items.length; i++) {
    const dm = items[i]?.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!dm) continue;
    const date = isoFromParts(dm[3] ?? "", dm[2] ?? "", dm[1] ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;
    const time = items[i + 1]?.match(/^(\d{1,2}:\d{2})$/)?.[1] ?? null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    performances.push({ date, time, status: date < today ? "past" : "scheduled" });
  }
  if (performances.length === 0) return null;
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: composer,
    detail_url: detailUrl,
    performances,
  };
}
