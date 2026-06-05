import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Theater Erfurt (`spielplan-html` strategy).
 *
 * Craft CMS, server-rendered. The opera index `/programm/musiktheater` links every
 * opera production as `/stuecke/{slug}`. Each detail page has the title (`<h1>`), the
 * composer ("… Musik von X …" subtitle), and the performance dates as
 * `<time datetime="YYYY-MM-DD">` inside `.dates-cards`. Future-only → Wikidata backfill.
 */

const BASE = "https://www.theater-erfurt.de";
/** Theater Erfurt on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415749";

export async function scrapeTheaterErfurt(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(`${BASE}/programm/musiktheater`, ctx);
    const slugs = [...new Set(index.match(/\/stuecke\/([a-z0-9-]+)/g) ?? [])].map((s) =>
      s.replace("/stuecke/", ""),
    );
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-erfurt: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-erfurt: index failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-erfurt: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-erfurt", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/stuecke/${slug}`;
  const html = await fetchHtml(detailUrl, ctx);
  const workTitle = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!workTitle) return null;

  // Dates live in the `.dates-cards` block; restrict the <time> scan to it.
  const cards =
    html.match(/dates-cards[\s\S]*?(?:<\/section>|<\/div>\s*<\/div>\s*<\/div>)/)?.[0] ?? html;
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];
  for (const m of cards.matchAll(/<time datetime="(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/g)) {
    const date = m[1] as IsoDate;
    if (window.since && date < window.since) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    performances.push({ date, time: m[2] ?? null, status: date < today ? "past" : "scheduled" });
  }
  if (performances.length === 0) return null;
  performances.sort((a, b) => a.date.localeCompare(b.date));

  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: composerFromText(stripHtml(html.match(/Musik von[\s\S]{0,80}/)?.[0] ?? "")),
    detail_url: detailUrl,
    performances,
  };
}
