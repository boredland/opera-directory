import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Saarländisches Staatstheater, Saarbrücken (`spielplan-html` strategy).
 *
 * TYPO3, server-rendered. `/produktionen` links every production as `/detail/{slug}`
 * (all divisions; the sparte filter is client-side). Each detail page's `<title>` is
 * "Title | {Sparte} | …" — keep "Musiktheater"; the `<h1>` is the title, a subtitle
 * gives "Oper/Operette von Composer", and the Termine list has DD.MM.YYYY dates.
 * Future-only → Wikidata backfill.
 */

const BASE = "https://www.staatstheater.saarland";
/** Saarländisches Staatstheater on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q208805";

export async function scrapeSaarlaendischesStaatstheater(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(`${BASE}/produktionen`, ctx);
    const slugs = [...new Set(index.match(/\/detail\/([a-z0-9-]+)/g) ?? [])].map((s) =>
      s.replace("/detail/", ""),
    );
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`saarlaendisches-staatstheater: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("saarlaendisches-staatstheater: index failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("saarlaendisches-staatstheater: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "saarlaendisches-staatstheater", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/detail/${slug}`;
  const html = await fetchHtml(detailUrl, ctx);
  const title = stripHtml(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");
  if (!/\|\s*Musiktheater\s*\|/i.test(title)) return null; // opera only

  const workTitle =
    stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "") || title.split("|")[0]?.trim();
  if (!workTitle) return null;

  // composer is in the subtitle "Oper/Operette von Composer" after the title
  const after = stripHtml(html.match(/<h1[^>]*>[\s\S]*?<\/h1>([\s\S]{0,300})/)?.[1] ?? "");
  const composer = composerFromText(after);

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];
  for (const m of html.matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{4})/g)) {
    const date = `${m[3]}-${m[2]?.padStart(2, "0")}-${m[1]?.padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    performances.push({ date, status: date < today ? "past" : "scheduled" });
  }
  if (performances.length === 0) return null;
  performances.sort((a, b) => a.date.localeCompare(b.date));

  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: composer,
    detail_url: detailUrl,
    performances,
  };
}
