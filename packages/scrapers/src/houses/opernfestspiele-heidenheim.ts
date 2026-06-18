import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Opernfestspiele Heidenheim (OH!) — the summer opera festival at Heidenheim an
 * der Brenz (`spielplan-html`, Joomla, no event JSON-LD).
 *
 * This is a FESTIVAL, not a year-round house: opera plays a few summer weeks
 * (~Jun–Jul) on the open-air Rittersaal of Schloss Hellenstein and in the
 * Festspielhaus CCH, run by the festival's own Cappella Aquileia orchestra. The
 * live leg therefore only ever sees the CURRENT edition's announced programme;
 * the deep past comes from Wikidata backfill (Q2026661 — but it carries no
 * production relations, so that leg is presently empty).
 *
 * Live source: the Spielplan (`/tickets-spielplan.html`) is one self-contained
 * page — every dated showing is a `<div class="… spielplanitem {genre}">` block
 * carrying its own date (DD / Wd / Mon / YYYY), time, work-type+composer line
 * ("Dramma lirico von Giuseppe Verdi"), title `<h2>`, venue `<p class="small">`
 * and detail URL. No per-night fetch is needed for the dates — one fetch yields
 * the whole programme.
 *
 * Opera gate: the genre token on each block separates the festival's strands.
 * Only `oper`-tagged blocks are staged sung works (Otello, Macbeth, the
 * children's "Hölle!", I masnadieri); `konzert` / `mk` (Meisterkonzert) /
 * `extras` (jazz, galas, matinées, picnics) are dropped. Blocks are grouped by
 * work title into one production each.
 *
 * Composer: read from the listing's work-type line via `composerFromText`
 * ("…von Giuseppe Verdi"). A production with no derivable composer is dropped
 * (the contract requires one) — this drops "Hölle!", a children's adaptation
 * whose source prints neither a "von …" line nor a Komposition credit.
 *
 * Cast + creative team: each work's detail page carries a "Kreativteam" table
 * (creative, German function labels) and a "Besetzung" table (sung roles), both
 * as `<td>Label</td><td itemprop="name">Name</td>` rows. Fetched once per work.
 */

const BASE = "https://www.opernfestspiele.de";
const SPIELPLAN_URL = `${BASE}/tickets-spielplan.html`;
/** Verified via wbsearchentities ("annual open-air opera festival in Heidenheim
 *  an der Brenz"); carries no P4647/P272 relations yet, so backfill is empty. */
const WIKIDATA_QID = "Q2026661";

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mär: "03",
  mae: "03",
  apr: "04",
  mai: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  okt: "10",
  nov: "11",
  dez: "12",
};

interface ListingRow {
  title: string;
  typeLine: string;
  detailUrl: string;
  performance: RawPerformance;
}

export async function scrapeOpernfestspieleHeidenheim(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const byTitle = await parseSpielplan(ctx, window);
    for (const rows of byTitle.values()) {
      try {
        const prod = await buildProduction(ctx, rows);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`opernfestspiele-heidenheim: ${rows[0]?.title} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("opernfestspiele-heidenheim: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opernfestspiele-heidenheim: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "opernfestspiele-heidenheim", productions };
}

/** Parse the single Spielplan page into opera-only performance rows, grouped by
 *  work title. Each `spielplanitem` block is one dated showing. */
async function parseSpielplan(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<Map<string, ListingRow[]>> {
  const html = await fetchHtml(SPIELPLAN_URL, ctx);
  const today = new Date().toISOString().slice(0, 10);
  const byTitle = new Map<string, ListingRow[]>();

  // Each block opens at a "spielplanitem {genre…}" wrapper and runs to the next.
  for (const block of html.split(/(?=class="mb-4 spielplanitem)/).slice(1)) {
    const genre = block.match(/^class="mb-4 spielplanitem ([^"]*)"/)?.[1] ?? "";
    if (!/\boper\b/.test(genre)) continue;

    const detailUrl = block.match(/href="(\/tickets-spielplan\/[^"]+\.html)"/)?.[1];
    const title = stripHtml(decodeEntities(block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? ""));
    // The type line carries an inline "Premiere"/"Premiere d. Wiederaufnahme"
    // badge `<span>`; cut it before reading the composer.
    const typeLine = stripHtml(
      decodeEntities(
        (block.match(/<p class="h5 text-uppercase[^"]*">([\s\S]*?)<\/p>/)?.[1] ?? "").split(
          "<span",
        )[0] ?? "",
      ),
    );
    const venue = stripHtml(
      decodeEntities(block.match(/<p class="small">([\s\S]*?)<\/p>/)?.[1] ?? ""),
    );
    if (!detailUrl || !title) continue;

    const date = parseDate(block);
    if (!date) continue;
    if (window.since && date < window.since) continue;

    const rows = byTitle.get(title) ?? [];
    rows.push({
      title,
      typeLine,
      detailUrl: `${BASE}${detailUrl}`,
      performance: {
        date,
        time: parseTime(block),
        venue_room: venue || null,
        status: /badge-danger[^>]*>\s*(?:Abgesagt|Entf)/i.test(block)
          ? "cancelled"
          : date < today
            ? "past"
            : "scheduled",
      },
    });
    byTitle.set(title, rows);
  }

  for (const rows of byTitle.values()) {
    rows.sort(
      (a, b) =>
        a.performance.date.localeCompare(b.performance.date) ||
        (a.performance.time ?? "").localeCompare(b.performance.time ?? ""),
    );
  }
  return byTitle;
}

/** Date stamp lives as "<…>DD</span> … Wd<br><b>Mon</b><br>YYYY". */
function parseDate(block: string): IsoDate | null {
  const dd = block.match(/condensed font-weight-normal">\s*(\d{1,2})\s*<\/span>/)?.[1];
  const my = block.match(/<br><b>([A-Za-zÄÖÜäöü]{3})<\/b><br>(\d{4})/);
  if (!dd || !my) return null;
  const mm = MONTHS[(my[1] ?? "").toLowerCase()];
  if (!mm) return null;
  return isoFromParts(my[2] ?? "", mm, dd);
}

function parseTime(block: string): string | null {
  return block.match(/<b[^>]*>(\d{1,2}:\d{2})\s*Uhr/)?.[1] ?? null;
}

async function buildProduction(
  ctx: FetchContext,
  rows: ListingRow[],
): Promise<RawProduction | null> {
  const first = rows[0];
  if (!first) return null;

  const composer = composerFromText(first.typeLine);
  if (!composer) return null;

  const { creative, cast } = await fetchCredits(ctx, first.detailUrl);

  return {
    source_production_id: new URL(first.detailUrl).pathname.split("/").pop() ?? first.detailUrl,
    work_title: titleCase(first.title),
    composer_name: composer,
    detail_url: first.detailUrl,
    creative_team: creative,
    cast,
    performances: rows.map((r) => r.performance),
  };
}

/** Pull the detail page's Kreativteam (creative) + Besetzung (cast) tables. */
async function fetchCredits(
  ctx: FetchContext,
  url: string,
): Promise<{ creative: RawCredit[]; cast: RawCredit[] }> {
  const html = await fetchHtml(url, ctx);
  return {
    creative: tableRows(html, "Kreativteam").map(({ label, name }) =>
      normalizeGermanCredit(label, name),
    ),
    cast: tableRows(html, "Besetzung").map(({ label, name }) => ({ role: label, name })),
  };
}

/** Rows of the named credit table: `<td>Label</td><td itemprop="name">Name</td>`. */
function tableRows(html: string, heading: string): { label: string; name: string }[] {
  const after = html.split(`>${heading}</h3>`)[1];
  if (!after) return [];
  const block = after.split("</table>")[0] ?? "";
  const rows: { label: string; name: string }[] = [];
  for (const [, rawLabel, rawName] of block.matchAll(
    /<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/td>/g,
  )) {
    const label = stripHtml(decodeEntities(rawLabel ?? ""));
    const name = stripHtml(decodeEntities(rawName ?? ""));
    if (label && name) rows.push({ label, name });
  }
  return rows;
}

/** The listing prints titles in all-caps ("OTELLO"); restore readable casing. */
function titleCase(title: string): string {
  if (title !== title.toUpperCase()) return title;
  return title
    .toLowerCase()
    .replace(/(^|[\s–-])([a-zà-ÿ])/g, (_, sep, ch) => sep + ch.toUpperCase());
}
