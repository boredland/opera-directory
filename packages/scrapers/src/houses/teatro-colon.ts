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

/**
 * Teatro Colón, Buenos Aires (`spielplan-html` strategy) — Argentina's premier
 * opera house and one of the world's great theatres.
 *
 * WordPress site, Spanish-language. Productions are a `production` custom post
 * type at `/produccion/{slug}/`, classified by a `production-category`
 * taxonomy. The opera filter is the category index `/categoria-produccion/opera/`
 * (paginated `/page/N/`); we follow only its `/produccion/{slug}/` links, so
 * ballet/danza/concerts/recitals never enter the set. The opera-studio strand
 * (devised pieces with no composer byline) is gated out by the composer
 * requirement below.
 *
 * One detail page yields everything for a production:
 *   - composer from the description byline "Música [y libreto] de {X}" (SPANISH —
 *     the German composerFromText is not used; parsed locally);
 *   - performances from the responsive day list — each night is a
 *     `<span class="capitalize">{weekday}</span> {dd/mm}, {HH:MM} hs` entry. The
 *     YEAR comes from the page's single `itemprop="startDate"` microdata
 *     (`dd/mm/yyyy` of the first night) and rolls forward when a month wraps
 *     (a Nov→Dec season crossing into January);
 *   - creative team from the `Label<br><b>Name</b>` paragraphs, whose Spanish
 *     function labels map to our slugs via CREATIVE_LABELS;
 *   - cast from the "Principales intérpretes" block (same markup; role then one
 *     or more bolded singers, often with per-night date markers we drop).
 *
 * Opera gate: a staged opera carries a "Música … de {X}" byline; pages without
 * one (promo pages, the opera-studio devised work) are dropped.
 *
 * `backfill` appends Wikidata (Q827401) for the deep past the live site drops.
 */

const BASE = "https://teatrocolon.org.ar";
const OPERA_INDEX = `${BASE}/categoria-produccion/opera`;

/** Teatro Colón on Wikidata — the OPERA HOUSE in Buenos Aires (Q827401), not the
 *  several other "Teatro Colón" theatres (A Coruña, Bogotá, Lima…). Verified via
 *  wbsearchentities ("opera house in Buenos Aires") and EntityData: P31 = opera
 *  house (Q153562), P856 website = https://teatrocolon.org.ar/. */
const WIKIDATA_QID = "Q827401";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/** Walk at most this many index pages so a stale "next page" link (WordPress
 *  serves an empty page 2 for a 5-opera season) can't loop unbounded. */
const MAX_INDEX_PAGES = 12;

/** Spanish creative-function labels → canonical function slugs, tested in order.
 *  Chorus/director rules precede the broader set/costume rules so a more specific
 *  label wins. "Diseño de {escenografía,vestuario,iluminación}" is the house's
 *  phrasing; bare "Escenografía" etc. also appear, so the keywords match either. */
const CREATIVE_LABELS: [RegExp, string][] = [
  [
    /dirección del coro|director(a)? del coro|maestro(a)? del coro|preparación del coro/i,
    "chorus-master",
  ],
  [/dirección musical|director(a)? musical/i, "conductor"],
  [/dirección de escena|dirección escénica|director(a)? de escena|régie|régisseur/i, "director"],
  [/coreograf/i, "choreographer"],
  [/iluminación/i, "lighting"],
  [/escenograf/i, "set-designer"],
  [/vestuario|figurines/i, "costume-designer"],
  [/dramaturg/i, "dramaturgy"],
];

export async function scrapeTeatroColon(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    for (const detailUrl of await operaShowUrls(ctx)) {
      try {
        const prod = await buildProduction(ctx, detailUrl, since);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-colon: ${detailUrl} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-colon: opera index scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-colon: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-colon", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** Distinct `/produccion/{slug}/` detail URLs from the opera category index,
 *  walking its pagination until a page adds nothing new (the season is small and
 *  WordPress serves a non-404 empty page past the last real one). */
async function operaShowUrls(ctx: FetchContext): Promise<string[]> {
  const urls = new Set<string>();
  for (let page = 1; page <= MAX_INDEX_PAGES; page++) {
    const indexUrl = page === 1 ? `${OPERA_INDEX}/` : `${OPERA_INDEX}/page/${page}/`;
    let html: string;
    try {
      html = await fetchHtml(indexUrl, ctx);
    } catch {
      break;
    }
    const before = urls.size;
    for (const [, href] of html.matchAll(
      /href="\s*(https:\/\/teatrocolon\.org\.ar\/produccion\/[^"#?]+?)\s*"/g,
    )) {
      if (href) urls.add(href.trim().replace(/\/$/, ""));
    }
    if (urls.size === before) break;
  }
  return [...urls];
}

async function buildProduction(
  ctx: FetchContext,
  detailUrl: string,
  since: IsoDate | null,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${detailUrl}/`, ctx);

  const composer = parseComposer(html);
  if (!composer) return null;

  const title = parseTitle(html);
  if (!title) return null;

  const performances = parsePerformances(html, since);
  if (performances.length === 0) return null;

  const { creative, cast } = parseCredits(html);

  return {
    source_production_id: detailUrl.split("/").pop() ?? detailUrl,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: detailUrl,
    creative_team: creative,
    cast,
    performances,
  };
}

/** Title is the page `<h1>`. */
function parseTitle(html: string): string | null {
  return stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "") || null;
}

/** Composer from the description byline "Música [y libreto] de {Name}". Trailing
 *  birth-year parens are dropped; absence of the byline gates out non-opera and
 *  the opera-studio devised pieces. */
function parseComposer(html: string): string | null {
  const text = stripHtml(html);
  const m = text.match(/Música(?:\s+y\s+libreto)?\s+de\s+([^.(<]+)/i);
  if (!m) return null;
  const name = (m[1] ?? "")
    .replace(/\s+/g, " ")
    .replace(/[,;]?\s*\(?\d{4}.*$/, "")
    .trim();
  return name || null;
}

/** Performances from the responsive day list. Each night is a
 *  `<span class="capitalize">{weekday}</span> {dd/mm}, {HH:MM} hs` entry; the
 *  year is seeded from the first night's `startDate` microdata and incremented
 *  when the month number drops below the previous one (a season that crosses the
 *  new year). */
function parsePerformances(html: string, since: IsoDate | null): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  let year = startYear(html);
  let prevMonth = 0;

  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  const re = /<span class="capitalize">[^<]*<\/span>\s*(\d{1,2})\/(\d{1,2}),?\s*([\d:]+)?\s*hs/g;
  for (const [, day, month, time] of html.matchAll(re)) {
    const mm = Number.parseInt(month ?? "", 10);
    if (!mm) continue;
    if (prevMonth && mm < prevMonth) year += 1;
    prevMonth = mm;

    const date = isoFromParts(year, mm, day ?? "");
    if (!date) continue;
    if (since && date < since) continue;
    const hhmm = (time ?? "").match(/\d{1,2}:\d{2}/)?.[0] ?? null;

    const key = `${date}|${hhmm ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time: hhmm, status: date < today ? "past" : "scheduled" });
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/** Year of the first night from the `<meta itemprop="startDate" content="dd/mm/yyyy">`
 *  microdata; falls back to the current year if absent. */
function startYear(html: string): number {
  const m = html.match(/itemprop="startDate"\s+content="\d{1,2}\/\d{1,2}\/(\d{4})"/);
  return m ? Number.parseInt(m[1] ?? "", 10) : new Date().getFullYear();
}

/**
 * Creative team and cast from the description column. Both use the same markup —
 * a `<p>` whose first line is a label/role, then one or more bolded names — so a
 * single scan splits on the "Principales intérpretes" heading: paragraphs before
 * it that carry a mapped function label are creative credits; paragraphs after it
 * are cast (role + singers). Names like "A definir" (TBD) are dropped.
 */
function parseCredits(html: string): { creative: RawCredit[]; cast: RawCredit[] } {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  const castStart = html.search(/<h3[^>]*>(?:<[^>]+>)*\s*Principales intérpretes/i);

  for (const para of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const block = para[1] ?? "";
    const idx = para.index ?? 0;
    const isCast = castStart >= 0 && idx > castStart;

    const labelRaw = block.split(/<br\s*\/?>/i)[0] ?? "";
    const label = stripHtml(labelRaw);
    if (!label) continue;
    const names = boldNames(block);
    if (names.length === 0) continue;

    if (isCast) {
      for (const name of names) {
        const key = `${label}|${name}`;
        if (seenCast.has(key)) continue;
        seenCast.add(key);
        cast.push({ role: label, name });
      }
    } else {
      const fn = mapFunction(label);
      if (!fn) continue;
      for (const name of names) {
        const key = `${fn}|${name}`;
        if (seenCreative.has(key)) continue;
        seenCreative.add(key);
        creative.push({ function: fn, name });
      }
    }
  }

  return { creative, cast };
}

/** Bolded person names in a credit/cast paragraph, with trailing per-night date
 *  markers ("(23, 25, 28)") stripped and placeholders dropped. */
function boldNames(block: string): string[] {
  const out: string[] = [];
  for (const [, raw] of block.matchAll(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi)) {
    const name = stripHtml(decodeEntities(raw ?? ""))
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
    if (name.length < 2) continue;
    if (/a definir/i.test(name)) continue;
    out.push(name);
  }
  return out;
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** Argentine opera seasons run within a calendar year (Mar–Dec); a production's
 *  season is just the year of its first performance. */
function seasonOf(date: IsoDate | null | undefined): string | null {
  return date ? date.slice(0, 4) : null;
}
