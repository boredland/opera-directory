import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Staatstheater Cottbus (`spielplan-html` strategy).
 *
 * Custom "visioncontent" CMS, fully server-rendered. `/de/spielplan.html` lists one
 * performance row per `<div id="article_{slug}" class="event-table">` carrying:
 * `<span class="… fulldate">YYYY-MM-DD</span>` (ISO date), `<span class="event-time">`,
 * `<span class="event-location">`, `<span class="event-division">…Musiktheater…</span>`
 * (genre — keep Musiktheater), `<h3 class="title"><span>Title`, and
 * `<div class="subtitle">… von Composer</div>`. Link `/de/programm/repertoire/artikel-{slug}.html`.
 * Group by slug. Future-only → Wikidata backfill.
 */

const BASE = "https://www.staatstheater-cottbus.de";
/** Staatstheater Cottbus on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q113482229";

interface Entry {
  title: string;
  composer: string | null;
  venue: string | null;
  perfs: RawPerformance[];
}

export async function scrapeStaatstheaterCottbus(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const productions: RawProduction[] = [];
  try {
    const html = await fetchHtml(`${BASE}/de/spielplan.html`, ctx);
    const bySlug = new Map<string, Entry>();
    // Split on the per-row marker; each chunk runs until the next article.
    const chunks = html.split(/<div id="article_/).slice(1);
    for (const chunk of chunks) {
      const division = stripHtml(chunk.match(/event-division">([\s\S]*?)<\/span>/)?.[1] ?? "");
      if (!/Musiktheater/i.test(division)) continue;
      // slug from the clean link; date is the id suffix "{slug_with_underscores}_{YYYY-MM-DD}".
      const slug = chunk.match(/artikel-([a-z0-9-]+)\.html/)?.[1];
      const date = chunk.match(/^[a-z0-9_]+_(\d{4}-\d{2}-\d{2})"/)?.[1] as IsoDate | undefined;
      if (!slug || !date) continue;
      if (window.since && date < window.since) continue;
      const time = chunk.match(/event-time">\s*(\d{1,2}[:.]\d{2})/)?.[1]?.replace(".", ":") ?? null;

      let entry = bySlug.get(slug);
      if (!entry) {
        const subtitle = stripHtml(chunk.match(/class="subtitle">([\s\S]*?)<\/div>/)?.[1] ?? "");
        entry = {
          title: stripHtml(chunk.match(/class="title[^"]*"[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? ""),
          composer: composerFromText(subtitle),
          venue: stripHtml(chunk.match(/event-location">([\s\S]*?)<\/span>/)?.[1] ?? "") || null,
          perfs: [],
        };
        bySlug.set(slug, entry);
      }
      if (!entry.perfs.some((p) => p.date === date && p.time === time)) {
        entry.perfs.push({
          date,
          time,
          venue_room: entry.venue,
          status: date < today ? "past" : "scheduled",
        });
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
        detail_url: `${BASE}/de/programm/repertoire/artikel-${slug}.html`,
        performances: e.perfs,
      });
    }
  } catch (err) {
    console.warn("staatstheater-cottbus: spielplan failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatstheater-cottbus: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatstheater-cottbus", productions };
}
