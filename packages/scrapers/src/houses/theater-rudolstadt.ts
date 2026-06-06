import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Theater Rudolstadt / Thüringer Landestheater Rudolstadt — "Schiller Theater
 * Rudolstadt", home of the Thüringer Symphoniker (`spielplan-html`, WordPress,
 * server-rendered, no proxy). Canonical host is schiller-theater.de
 * (theater-rudolstadt.de redirects to it).
 *
 * Drama-heavy house that also stages Musiktheater (Oper/Operette). The spielplan
 * `/programm/spielplan/?datum=YYYY-MM` is paginated by month: each day is an
 * `<a name="day_N">` block whose `<h3><strong>DD</strong></h3>` carries the day,
 * and every event row inside links `/stueck/{slug}/`, prints its genre+composer
 * line as `<p class="mb-2">{genre} von {Composer}</p>`, then a second
 * `<p class="mb-2">HH:MM Uhr … <br>{Venue}</p>`. The genre line both gates the
 * production (must match a music-theatre marker) and yields the composer
 * (composerFromText) — dropping Schauspiel, Konzert, Ballett, Junges Theater.
 *
 * Performances of one work across nights are grouped by slug into a single
 * production; its detail page (`/stueck/{slug}/`) is fetched once for the
 * "Mitwirkende" collapser — a creative-team `<p>` ("Label: Name<br>…", German
 * labels) followed by a cast `<p>` ("Role: Singer / Singer<br>…"). Future +
 * current season only (the spielplan exposes the running season's months) →
 * Wikidata backfill for the deep past.
 */

const BASE = "https://schiller-theater.de";
/** Schiller-Theater Rudolstadt on Wikidata — verified via wbsearchentities +
 *  wbgetentities: P31 theatre, P131 Rudolstadt, P856 → theater-rudolstadt.de /
 *  schiller-theater.de. Alias "Theater Rudolstadt". */
const WIKIDATA_QID = "Q2415942";

/** Genre markers that flag a sung music-theatre piece on the spielplan genre line.
 *  Excludes Schauspiel/Konzert/Sinfonie/Ballett/Musical/Junges Theater/Lesung. */
const MUSIC_THEATRE =
  /\b(oper(ette)?\b|opéra|spieloper|komische\s+oper|singspiel|musikdrama|dramma\s+(giocoso|per\s+musica|lirico)|opera\s+(seria|buffa)|tragéd(ie|ia)\s+lyrique|operngala)/i;

interface SpielplanRow {
  slug: string;
  title: string;
  genreLine: string;
  performance: RawPerformance;
}

export async function scrapeTheaterRudolstadt(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const rowsBySlug = new Map<string, SpielplanRow[]>();
    for (const month of seasonMonths(window)) {
      try {
        const html = await fetchHtml(`${BASE}/programm/spielplan/?datum=${month}`, ctx);
        const rows = parseMonth(html, month, window);
        for (const row of rows) {
          const list = rowsBySlug.get(row.slug) ?? [];
          list.push(row);
          rowsBySlug.set(row.slug, list);
        }
      } catch (err) {
        console.warn(`theater-rudolstadt: month ${month} failed:`, err);
      }
    }

    for (const [slug, rows] of rowsBySlug) {
      try {
        const prod = await buildProduction(ctx, slug, rows);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-rudolstadt: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-rudolstadt: scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-rudolstadt: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-rudolstadt", productions };
}

/** Months to walk as "YYYY-MM": from window.since (or a recent-past floor) up to
 *  one season ahead. The spielplan only renders the running season, so unpublished
 *  future months simply yield no rows. */
function seasonMonths(window: ScrapeWindow): string[] {
  const now = new Date();
  const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  let start = floor;
  if (window.mode === "backfill" && window.since) {
    const since = new Date(`${window.since}T00:00:00Z`);
    if (since < start) start = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1));
  }
  const end = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth() + 1, 1));
  const months: string[] = [];
  for (let d = start; d < end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

/** One month page: each `<a name="day_N">` block holds the day's `<h3><strong>DD
 *  </strong></h3>` and its event rows. Scoped to `.spielplan-content` so the
 *  recurring `.footer-boxes` recommendations don't leak in as performances. */
function parseMonth(html: string, month: string, window: ScrapeWindow): SpielplanRow[] {
  const today = new Date().toISOString().slice(0, 10);
  const content = sliceBetween(html, "spielplan-content", "footer-boxes");
  const rows: SpielplanRow[] = [];

  for (const dayBlock of content.split(/<a name="day_\d+"><\/a>/).slice(1)) {
    const dd = dayBlock.match(/<h3[^>]*>\s*<strong>\s*(\d{1,2})\s*<\/strong>/)?.[1];
    if (!dd) continue;
    const date = `${month}-${dd.padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;

    for (const ev of dayBlock.split('class="headline-link"').slice(1)) {
      const slug = ev.match(/href="[^"]*\/stueck\/([a-z0-9-]+)\//i)?.[1];
      const title = stripHtml(ev.match(/>([\s\S]*?)<\/a>/)?.[1] ?? "");
      if (!slug || !title) continue;

      const paras = [...ev.matchAll(/<p class="mb-2">([\s\S]*?)<\/p>/g)].map((m) => m[1] ?? "");
      const genreLine = stripHtml(paras[0] ?? "");
      const timeBlock = paras[1] ?? "";
      const time = timeBlock.match(/(\d{1,2}:\d{2})/)?.[1] ?? null;
      const venue =
        stripHtml((timeBlock.split(/<br\s*\/?>/i)[1] ?? "").replace(/&nbsp;/g, " ")) || null;

      rows.push({
        slug,
        title,
        genreLine,
        performance: {
          date,
          time,
          venue_room: venue,
          status: date < today ? "past" : "scheduled",
        },
      });
    }
  }
  return rows;
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  rows: SpielplanRow[],
): Promise<RawProduction | null> {
  const genreLine = rows.map((r) => r.genreLine).find((g) => MUSIC_THEATRE.test(g));
  if (!genreLine) return null;
  const composer = composerFromText(genreLine);
  if (!composer) return null;

  const performances = dedupePerformances(rows.map((r) => r.performance));
  if (performances.length === 0) return null;

  const url = `${BASE}/stueck/${slug}/`;
  const { cast, creative } = await parseCredits(ctx, url);

  return {
    source_production_id: slug,
    work_title: rows[0]?.title ?? slug,
    composer_name: composer,
    is_revival: rows.some((r) => /wiederaufnahme/i.test(r.genreLine)),
    detail_url: url,
    presentation_note: genreLine || null,
    creative_team: creative,
    cast,
    performances,
  };
}

function dedupePerformances(performances: RawPerformance[]): RawPerformance[] {
  const seen = new Set<string>();
  const out: RawPerformance[] = [];
  for (const p of performances) {
    const key = `${p.date}|${p.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/** Detail page "Mitwirkende" collapser: a creative-team `<p>` of "Label: Name<br>
 *  …" (German labels), then a cast `<p>` of "Role: Singer / Singer<br>…". Names
 *  sit in either `<a>` (ensemble members) or `<span>`; the ensemble/orchestra
 *  catch-all row ("Es spielen: …") is dropped. Other collapsers on the page hold
 *  press reviews, so anchor on the "Mitwirkende" heading. */
async function parseCredits(
  ctx: FetchContext,
  url: string,
): Promise<{ cast: RawCredit[]; creative: RawCredit[] }> {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  try {
    const html = await fetchHtml(url, ctx);
    const block = sliceBetween(sliceFrom(html, "Mitwirkende"), "collapser-content", "</div>");
    const paras = [...block.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1] ?? "");

    for (const [pIndex, para] of paras.entries()) {
      for (const line of para.split(/<br\s*\/?>/i)) {
        const m = line.match(/^([^:<]+?):\s*(.+)$/s);
        if (!m?.[1] || !m[2]) continue;
        const label = stripHtml(m[1]);
        const name = stripHtml(m[2]);
        // "Es spielen:" / "Mit:" head the orchestra/chorus catch-all, not a person.
        if (!label || !name || /^(es spiel(en|t)|mit)$/i.test(label)) continue;

        if (pIndex === 0) {
          const credit = normalizeGermanCredit(label, name);
          creative.push(credit.function ? credit : { function: label, name });
        } else {
          cast.push({ role: label, name });
        }
      }
    }
  } catch (err) {
    console.warn(`theater-rudolstadt: credits ${url} failed:`, err);
  }
  return { cast, creative };
}

/** Slice from the first occurrence of `marker` to end-of-string. */
function sliceFrom(html: string, marker: string): string {
  const i = html.indexOf(marker);
  return i === -1 ? "" : html.slice(i);
}

/** Slice from the first occurrence of `startMarker` to the next `endMarker`. */
function sliceBetween(html: string, startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  if (start === -1) return "";
  const rest = html.slice(start);
  const end = rest.indexOf(endMarker, startMarker.length);
  return end === -1 ? rest : rest.slice(0, end);
}
