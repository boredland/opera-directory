import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";

/**
 * Oper Chemnitz — the opera house of Die Theater Chemnitz (`spielplan-html`).
 *
 * Server-rendered. `/spielplan/` lists one `<section class="cc_event">` per
 * performance: a `cc_hllink` to `/spielplan/detailseite/{slug}/{id}` wrapping the
 * title (`<h2>`), the "genre von Composer" line (`<h3>`) and the genre
 * (`<div class="cc_type">` — we keep Musiktheater / Oper / Operette / Zeitgenössische
 * Oper), plus a `cc_data` block with `cc_date` / `cc_time` / `cc_loc`. Grouped by slug.
 * Cast isn't in the listing. Coverage is the rendered window (~current month); deep
 * history via Wikidata.
 */

const BASE = "https://www.theater-chemnitz.de";
/** Chemnitz Opera on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q315578";

const OPERA_TYPES = new Set(["Musiktheater", "Oper", "Operette", "Zeitgenössische Oper"]);

interface Entry {
  title: string;
  composer: string | null;
  venue: string | null;
  perfs: RawPerformance[];
}

export async function scrapeOperChemnitz(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const html = await fetchHtml(`${BASE}/spielplan/`, ctx);
    for (const [slug, e] of parseSpielplan(html, window)) {
      if (e.perfs.length === 0) continue;
      productions.push({
        source_production_id: slug,
        work_title: e.title,
        composer_name: e.composer,
        detail_url: `${BASE}/spielplan/detailseite/${slug}`,
        performances: e.perfs,
      });
    }
  } catch (err) {
    console.warn("oper-chemnitz: spielplan failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("oper-chemnitz: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "oper-chemnitz", productions };
}

function parseSpielplan(html: string, window: ScrapeWindow): Map<string, Entry> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, Entry>();
  for (const m of html.matchAll(/<section class="cc_event">([\s\S]*?)<\/section>/g)) {
    const card = m[1] ?? "";
    const slug = card.match(/\/spielplan\/detailseite\/([a-z0-9-]+)\//)?.[1];
    const type = stripHtml(card.match(/<div class="cc_type">([\s\S]*?)<\/div>/)?.[1] ?? "");
    if (!slug || !OPERA_TYPES.has(type)) continue;
    const composer =
      stripHtml(card.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? "")
        .match(/\bvon\s+(.+)$/)?.[1]
        ?.trim() ?? null;
    if (!composer) continue; // drops Führungen/tours filed under Musiktheater

    const dm = card.match(/cc_date">\s*(\d{2})\.(\d{2})\.(\d{4})/);
    if (!dm) continue;
    const date = `${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = card.match(/cc_time">\s*(\d{1,2})\.(\d{2})/);

    let entry = bySlug.get(slug);
    if (!entry) {
      entry = {
        title: stripHtml(card.match(/<h2>([\s\S]*?)<\/h2>/)?.[1] ?? ""),
        composer,
        venue: stripHtml(card.match(/cc_loc">([\s\S]*?)<\/div>/)?.[1] ?? "") || null,
        perfs: [],
      };
      bySlug.set(slug, entry);
    }
    if (!entry.title) continue;
    const seen = entry.perfs.some(
      (p) =>
        p.date === date && p.time === (time ? `${time[1]?.padStart(2, "0")}:${time[2]}` : null),
    );
    if (!seen) {
      entry.perfs.push({
        date,
        time: time ? `${time[1]?.padStart(2, "0")}:${time[2]}` : null,
        venue_room: entry.venue,
        status: date < today ? "past" : "scheduled",
      });
    }
  }
  for (const e of bySlug.values()) {
    e.perfs.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
  }
  return bySlug;
}
