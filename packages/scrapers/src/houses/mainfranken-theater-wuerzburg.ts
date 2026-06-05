import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { parseMeta } from "./_theater-cms";

/**
 * Mainfranken Theater Würzburg (`spielplan-html` strategy).
 *
 * spiritec WebCMS, server-rendered. `/programm/spielplan/` lists `.performance` cards
 * (`id="{YYYY-MM-DD}-p{id}"`, `data-day-token`, schema.org `startDate`) linking to
 * `/programm/spielplan/{slug}/{id}/`. The card id is per-performance, so group by slug.
 * Each detail page's `<meta name="description">` is the shared "Title, Oper von
 * Composer, Besetzung: Role: Name" run → keep the opera genres and reuse `parseMeta`.
 * Future-only → Wikidata backfill.
 */

const BASE = "https://www.mainfrankentheater.de";
/** Mainfranken Theater on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1885618";
const OPERA_GENRE = /\b(Oper|Operette|Singspiel|Musiktheater|opéra|opera|dramma|lirico)\b/i;

export async function scrapeMainfrankenTheaterWuerzburg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const productions: RawProduction[] = [];
  try {
    const html = await fetchHtml(`${BASE}/programm/spielplan/`, ctx);
    const bySlug = new Map<string, { path: string; perfs: RawPerformance[] }>();
    for (const card of html.split(/class="performance /).slice(1)) {
      const date = card.match(/data-day-token="(\d{4}-\d{2}-\d{2})"/)?.[1] as IsoDate | undefined;
      const link = card.match(/\/programm\/spielplan\/([a-z0-9-]+)\/\d+\//);
      const slug = link?.[1];
      if (!date || !slug || !link) continue;
      if (window.since && date < window.since) continue;
      const time = card.match(/startDate"\s+content="[^"]*T(\d{2}:\d{2})/)?.[1] ?? null;
      const entry = bySlug.get(slug) ?? { path: link[0], perfs: [] };
      if (!entry.perfs.some((p) => p.date === date && p.time === time)) {
        entry.perfs.push({ date, time, status: date < today ? "past" : "scheduled" });
      }
      bySlug.set(slug, entry);
    }

    for (const [slug, { path, perfs }] of bySlug) {
      try {
        const prod = await buildProduction(ctx, slug, path, perfs);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`mainfranken-theater-wuerzburg: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("mainfranken-theater-wuerzburg: spielplan failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("mainfranken-theater-wuerzburg: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "mainfranken-theater-wuerzburg", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  path: string,
  perfs: RawPerformance[],
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}${path}`;
  const html = await fetchHtml(detailUrl, ctx);
  const workTitle = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "").replace(
    /:\s*$/,
    "",
  );
  const meta = decodeEntities(
    html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/)?.[1] ?? "",
  );
  if (!workTitle || !OPERA_GENRE.test(meta)) return null;

  const { composer, creative_team, cast } = parseMeta(meta, workTitle);
  perfs.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: composer,
    detail_url: detailUrl,
    creative_team,
    cast,
    performances: perfs,
  };
}
