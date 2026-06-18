import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { isoFromParts } from "./_dates";
import { composerFromText } from "./_german-credits";

/**
 * Uckermärkische Bühnen Schwedt (`spielplan-html`). A predominantly
 * operetta/musical/Schauspiel house with a small music-theatre strand; its own
 * "Oper & Operette" category typically holds only a handful of events per
 * season, most of which are revues/galas rather than staged works.
 *
 * Bespoke CMS, server-rendered, no proxy. The spielplan (`/ubs/page/110/`)
 * supports server-side category filters; `/filter/137438953472/` is the
 * "Oper & Operette" view. It is one `<table>` of `<tr>` event rows: a `td.day`
 * carries the German date (`<span class="daynum">DD</span>` + "Month YYYY") and
 * the content `<td>` carries `<span class="title">…</span>`,
 * `<span class="descr">…</span>` and `<span class="spbottom"><b>HH:MM Uhr</b>,
 * {venue}, {price}</span>`. Staged events link to `/ubs/article/{id}/`.
 *
 * Galas/revues/coffee-concerts have no composer in the row, so requiring a
 * composer (read off the detail page's "Musik von … / Oper „…“ von …" line)
 * drops them and keeps only genuine staged opera/operetta. Future-only →
 * Wikidata backfill.
 */

const BASE = "https://www.theater-schwedt.de";
/** "Oper & Operette" category filter on the spielplan. */
const OPER_FILTER_URL = `${BASE}/ubs/page/110/filter/137438953472/`;
/** Uckermärkische Bühnen Schwedt on Wikidata (Q1393858, "municipal theatre of Schwedt"). */
const WIKIDATA_QID = "Q1393858";

const GERMAN_MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  märz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

interface ListRow {
  articleId: string | null;
  title: string;
  date: IsoDate;
  time: string | null;
  venue: string | null;
}

export async function scrapeUckermaerkischeBuehnenSchwedt(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const rows = parseListRows(await fetchHtml(OPER_FILTER_URL, ctx));
    const byId = new Map<string, ListRow[]>();
    for (const row of rows) {
      if (!row.articleId) continue; // non-staged revues/series have no detail page
      const group = byId.get(row.articleId) ?? [];
      group.push(row);
      byId.set(row.articleId, group);
    }

    for (const [articleId, group] of byId) {
      try {
        const prod = await buildProduction(ctx, articleId, group, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`uckermaerkische-buehnen-schwedt: article ${articleId} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("uckermaerkische-buehnen-schwedt: spielplan failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("uckermaerkische-buehnen-schwedt: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "uckermaerkische-buehnen-schwedt", productions };
}

function parseListRows(html: string): ListRow[] {
  const table = html.match(/<div id="spielplan">([\s\S]*?)<\/table>/)?.[1] ?? "";
  const rows: ListRow[] = [];
  for (const tr of table.split(/<tr/).slice(1)) {
    const date = parseDate(tr);
    if (!date) continue;
    const articleId = tr.match(/\/ubs\/article\/(\d+)\//)?.[1] ?? null;
    const title = stripHtml(tr.match(/class="title">([\s\S]*?)<\/span>/)?.[1] ?? "");
    if (!title) continue;
    const bottom = tr.match(/class="[^"]*spbottom">([\s\S]*?)<\/span>/)?.[1] ?? "";
    const time = bottom.match(/(\d{1,2}[:.]\d{2})\s*Uhr/)?.[1]?.replace(".", ":") ?? null;
    const venue = stripHtml(bottom.match(/class="silent">([\s\S]*?)<\/a>/)?.[1] ?? "") || null;
    rows.push({ articleId, title, date, time, venue });
  }
  return rows;
}

/** A `td.day` block: "<span class=daynum>DD</span><br>{Month} {YYYY}". */
function parseDate(tr: string): IsoDate | null {
  const day = tr.match(/class="daynum">(\d{1,2})</)?.[1];
  const dayBlock = tr.match(/class="daystring">([\s\S]*?)<\/span><\/td>/)?.[1] ?? tr;
  const my = stripHtml(dayBlock).match(/([A-Za-zÄÖÜäöü]+)\s+(\d{4})/);
  if (!day || !my?.[1]) return null;
  const month = GERMAN_MONTHS[my[1].toLowerCase()];
  if (!month) return null;
  return isoFromParts(my[2] ?? "", month, day);
}

async function buildProduction(
  ctx: FetchContext,
  articleId: string,
  rows: ListRow[],
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/ubs/article/${articleId}/`;
  const detail = await fetchHtml(url, ctx);
  const composer = composerFromDetail(detail);
  if (!composer) return null; // revues/galas with no named composer are dropped

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];
  for (const row of rows) {
    if (window.since && row.date < window.since) continue;
    const key = `${row.date}|${row.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    performances.push({
      date: row.date,
      time: row.time,
      venue_room: row.venue,
      status: row.date < today ? "past" : "scheduled",
    });
  }
  if (performances.length === 0) return null;
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  return {
    source_production_id: articleId,
    work_title: cleanTitle(rows[0]?.title ?? ""),
    composer_name: composer,
    detail_url: url,
    performances,
  };
}

/** The composer rides in the detail body's "Musik von …" / "Oper „…“ von …"
 *  phrase; the generic leading "von" (often a librettist/playwright) is wrong,
 *  so anchor on those phrases before falling back. */
function composerFromDetail(html: string): string | null {
  const body = stripHtml(html.match(/id="ckedited">([\s\S]*?)<div class="clearfix"/)?.[1] ?? html);
  const anchored =
    body.match(/Musik von\s+([A-ZÄÖÜ][^.,;()]+)/)?.[1] ??
    body.match(/Oper\s*[„"“][^"“”]*[“"”]\s*von\s+([A-ZÄÖÜ][^.,;()]+)/)?.[1] ??
    body.match(/Operette\s*(?:[„"“][^"“”]*[“"”]\s*)?von\s+([A-ZÄÖÜ][^.,;()]+)/)?.[1];
  if (anchored) return composerFromText(`Musik von ${anchored}`);
  return null;
}

/** Strip a house wrapper like Uckeroper "Faust" → Faust. */
function cleanTitle(title: string): string {
  const quoted = title.match(/[„"“]([^"“”]+)[“"”]/)?.[1];
  return (quoted ?? title).trim();
}
