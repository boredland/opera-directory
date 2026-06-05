import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Oper Halle — Bühnen Halle (`spielplan-html` strategy).
 *
 * Django CMS, server-rendered. `/de/program?genre=oper` filters to opera server-side.
 * Each `<li class="event-item">` has the title (`<a class="event-title"><span class="h2">`),
 * a `roofline event-genre` line, a date as plain text ("Mi, 10.06.2026, 19:30 Uhr"),
 * a `.location`, and a link `/de/program/{slug}/{id}` (one per performance). Grouped by
 * slug. Composer comes from the detail page subtitle. Future-only → Wikidata backfill.
 */

const BASE = "https://www.buehnen-halle.de";
/** Oper Halle on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q113485171";

interface Entry {
  title: string;
  detailPath: string;
  perfs: RawPerformance[];
}

export async function scrapeOperHalle(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const productions: RawProduction[] = [];
  try {
    const html = await fetchHtml(`${BASE}/de/program?genre=oper`, ctx);
    const bySlug = new Map<string, Entry>();
    for (const chunk of html.split(/<li class="event-item/).slice(1)) {
      const link = chunk.match(/\/de\/program\/([a-z0-9-]+)\/(\d+)/);
      const slug = link?.[1];
      if (!slug || !link) continue;
      const dm = chunk.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,\s*(\d{1,2}:\d{2}))?/);
      if (!dm) continue;
      const date = `${dm[3]}-${dm[2]?.padStart(2, "0")}-${dm[1]?.padStart(2, "0")}` as IsoDate;
      if (window.since && date < window.since) continue;

      let entry = bySlug.get(slug);
      if (!entry) {
        entry = {
          title: stripHtml(chunk.match(/event-title"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""),
          detailPath: `/de/program/${slug}/${link[2]}`,
          perfs: [],
        };
        bySlug.set(slug, entry);
      }
      if (!entry.perfs.some((p) => p.date === date && p.time === (dm[4] ?? null))) {
        entry.perfs.push({
          date,
          time: dm[4] ?? null,
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
        composer_name: await fetchComposer(ctx, `${BASE}${e.detailPath}`),
        detail_url: `${BASE}${e.detailPath}`,
        performances: e.perfs,
      });
    }
  } catch (err) {
    console.warn("oper-halle: spielplan failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("oper-halle: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "oper-halle", productions };
}

/** Detail page subtitle near the title carries "… von Composer". */
async function fetchComposer(ctx: FetchContext, url: string): Promise<string | null> {
  try {
    const html = await fetchHtml(url, ctx);
    const head = stripHtml(html.match(/<h1[^>]*>([\s\S]{0,400})/)?.[1] ?? html.slice(0, 4000));
    return composerFromText(head);
  } catch {
    return null;
  }
}
