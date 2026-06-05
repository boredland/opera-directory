import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Staatstheater Darmstadt (`spielplan-html` strategy).
 *
 * Custom webfactory CMS, fully server-rendered. `/spielplan/` lists
 * `<article class="termin js-termin">` rows: `termin__anchor` →
 * `/veranstaltungen/{slug}.{id}/`, `<h3 class="termin__title">`, `<time datetime>`
 * (ISO date+time), a venue span, and `termin__details` whose first line is the
 * genre+composer ("Oper von …"). Keep the opera genres; group by slug. Future-only
 * → Wikidata backfill.
 */

const BASE = "https://www.staatstheater-darmstadt.de";
/** Staatstheater Darmstadt on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2325343";
const OPERA = /\b(Oper|Operette|Kammeroper|Familienoper|Musiktheater|Kurzopern|Spieloper)\b/i;

interface Entry {
  title: string;
  composer: string | null;
  detailPath: string;
  perfs: RawPerformance[];
}

export async function scrapeStaatstheaterDarmstadt(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const productions: RawProduction[] = [];
  try {
    const html = await fetchHtml(`${BASE}/spielplan/`, ctx);
    const bySlug = new Map<string, Entry>();
    for (const m of html.matchAll(/<article class="termin[^"]*"[\s\S]*?<\/article>/g)) {
      const row = m[0];
      const link = row.match(/\/veranstaltungen\/([a-z0-9-]+)\.(\d+)/);
      const slug = link?.[1];
      const iso = row.match(/<time datetime="(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (!slug || !link || !iso) continue;
      const details = stripHtml(
        row.match(/termin__details[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? "",
      ).slice(0, 120);
      if (!OPERA.test(details)) continue;
      const date = iso[1] as IsoDate;
      if (window.since && date < window.since) continue;

      let entry = bySlug.get(slug);
      if (!entry) {
        entry = {
          title: stripHtml(row.match(/termin__title">([\s\S]*?)<\/h3>/)?.[1] ?? ""),
          composer: composerFromText(details),
          detailPath: `/veranstaltungen/${slug}.${link[2]}/`,
          perfs: [],
        };
        bySlug.set(slug, entry);
      }
      const time = iso[2] ?? null;
      if (!entry.perfs.some((p) => p.date === date && p.time === time)) {
        entry.perfs.push({ date, time, status: date < today ? "past" : "scheduled" });
      }
    }
    for (const [slug, e] of bySlug) {
      if (!e.title || e.perfs.length === 0) continue;
      e.perfs.sort(
        (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
      );
      productions.push({
        source_production_id: slug,
        work_title: e.title,
        composer_name: e.composer,
        detail_url: `${BASE}${e.detailPath}`,
        performances: e.perfs,
      });
    }
  } catch (err) {
    console.warn("staatstheater-darmstadt: spielplan failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatstheater-darmstadt: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatstheater-darmstadt", productions };
}
