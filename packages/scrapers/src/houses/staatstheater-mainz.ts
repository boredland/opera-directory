import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { isoFromParts } from "./_dates";
import { composerFromText } from "./_german-credits";

/**
 * Staatstheater Mainz (`spielplan-html` strategy).
 *
 * Kirby CMS, server-rendered. The opera section `/veranstaltungen/oper-{YY-YY}` links
 * every opera production as `/veranstaltungen/oper-{YY-YY}/{slug}`. Each detail page has
 * a `<div class='headline'>{Title} von {Composer} ({year})</div>` and a TERMINE block of
 * plain `DD.MM.YYYY` dates. We walk the current + next season; the `since` window drops
 * stray past dates. Future-only → Wikidata backfill.
 */

const BASE = "https://www.staatstheater-mainz.com";
/** Staatstheater Mainz on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q317908";

export async function scrapeStaatstheaterMainz(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  const slugToSection = new Map<string, string>();
  for (const season of currentSeasons()) {
    const section = `oper-${season}`;
    try {
      const index = await fetchHtml(`${BASE}/veranstaltungen/${section}`, ctx);
      for (const m of index.matchAll(new RegExp(`/veranstaltungen/${section}/([a-z0-9-]+)`, "g"))) {
        if (m[1]) slugToSection.set(`${section}/${m[1]}`, m[1]);
      }
    } catch {
      /* season not published */
    }
  }

  for (const [path] of slugToSection) {
    try {
      const prod = await buildProduction(ctx, path, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`staatstheater-mainz: ${path} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatstheater-mainz: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatstheater-mainz", productions };
}

function currentSeasons(): string[] {
  const now = new Date();
  const yy = now.getUTCFullYear() % 100;
  const start = now.getUTCMonth() + 1 >= 8 ? yy : yy - 1;
  const fmt = (a: number) => `${String(a).padStart(2, "0")}-${String(a + 1).padStart(2, "0")}`;
  return [fmt(start), fmt(start + 1)];
}

async function buildProduction(
  ctx: FetchContext,
  path: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/veranstaltungen/${path}`;
  const html = await fetchHtml(detailUrl, ctx);
  const headline = stripHtml(html.match(/class=['"]headline['"]>([\s\S]*?)<\/div>/)?.[1] ?? "");
  const workTitle =
    headline.split(/\s+von\s+/)[0]?.trim() ||
    stripHtml(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "")
      .split("-")
      .pop()
      ?.trim() ||
    "";
  if (!workTitle) return null;

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];
  for (const m of html.matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{4})/g)) {
    const date = isoFromParts(m[3] ?? "", m[2] ?? "", m[1] ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;
    if (date < "2025-01-01" || seen.has(date)) continue; // drop stray historic refs
    seen.add(date);
    performances.push({ date, status: date < today ? "past" : "scheduled" });
  }
  if (performances.length === 0) return null;
  performances.sort((a, b) => a.date.localeCompare(b.date));

  const slug = path.split("/").pop() ?? path;
  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: composerFromText(headline),
    detail_url: detailUrl,
    performances,
  };
}
