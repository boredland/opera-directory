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

/**
 * Teatro alla Scala, Milan (`spielplan-html` strategy). The world-class house's
 * season opens Dec 7 (Sant'Ambrogio) and runs into the following autumn; opera,
 * ballet and concerts (Filarmonica) share the same cartellone.
 *
 * The Italian site (`/it/`) is a static-page CMS with a clean, segregated URL
 * tree: each season index at `/it/stagione/{YYYY-YYYY}/index.html` links every
 * production by discipline, and an opera lives at `…/opera/{slug}.html`. The
 * homepage links the current + next season indexes, so we discover seasons from
 * there (robust across the year rollover) and keep only the `/opera/` detail
 * URLs — that path is the opera filter, dropping balletto / concerto / recital.
 *
 * Each opera detail page carries everything inline (no JSON-LD, no API):
 *   - composer in `<div class="cnt__subtitle">` — REQUIRED (the opera gate);
 *   - creative team in a `table table-prd` of `<th scope="row">Label</th><td>Name`
 *     rows whose ITALIAN labels (Direttore, Regia, Scene, Costumi, Luci, …) map
 *     to canonical functions in CREATIVE_LABELS below;
 *   - cast in `<table class="evt">` of `<td class="dt">Role</td><td>Singer (dates)
 *     / Singer (dates)</td>` rows (the per-night date hints are stripped);
 *   - performances in `<time class="cal__date" datetime="…+02:00">` slides, with a
 *     "Sold out" / "Last seats" ticket button giving the status.
 *
 * Historical seasons sit under `/it/archivio`, which robots.txt disallows, so the
 * deep past comes from Wikidata (Q5471, ~450 productions) in backfill mode.
 */

const BASE = "https://www.teatroallascala.org";
const HOME_URL = `${BASE}/it/index.html`;
const VENUE = "Teatro alla Scala";
/** La Scala on Wikidata — verified via wbsearchentities (it): "La Scala", opera
 *  house in Milan, P17 = Italy (Q38), P31 includes theatre building + opera
 *  company; 457 works link via P4647 (premiere here) / P272 (produced here). */
const WIKIDATA_QID = "Q5471";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/**
 * Italian creative-function labels → canonical function keys, tested in order;
 * English equivalents from the `/en/` mirror are folded in so the map survives a
 * site-language flip. "Regia" is matched before set/costume rules because the
 * site combines it ("Regia e scene"), and chorus-master precedes the generic
 * conductor rule. Unmapped labels are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro|chorus master/i, "chorus-master"],
  [/direttore|direzione musicale|maestro concertatore|conductor/i, "conductor"],
  [/regia|staging|director/i, "director"],
  [/coreograf|choreograph/i, "choreographer"],
  [/disegno luci|^luci\b|^luce\b|lights|lighting/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi|costumes/i, "costume-designer"],
  [/scenografia|^scene\b|^sets?\b|set design/i, "set-designer"],
  [/drammaturgia|dramaturgy/i, "dramaturgy"],
];

export async function scrapeTeatroAllaScala(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const seasonUrls = await discoverSeasonIndexes(ctx);

    const detailUrls = new Set<string>();
    for (const seasonUrl of seasonUrls) {
      try {
        for (const url of await parseSeasonOperaLinks(seasonUrl, ctx)) detailUrls.add(url);
      } catch (err) {
        console.warn(`teatro-alla-scala: season index ${seasonUrl} failed:`, err);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const detailUrl of detailUrls) {
      try {
        const prod = await buildProduction(detailUrl, ctx, since, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-alla-scala: ${detailUrl} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-alla-scala: season scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-alla-scala: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-alla-scala", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** The homepage links the current + next season indexes; reading them there keeps
 *  the adapter correct across the Dec season rollover without a hardcoded year. */
async function discoverSeasonIndexes(ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(HOME_URL, ctx);
  const urls = new Set<string>();
  for (const [, path] of html.matchAll(/href="(\/it\/stagione\/\d{4}-\d{4}\/index\.html)"/gi)) {
    urls.add(`${BASE}${path}`);
  }
  return [...urls];
}

/** A season index lists every production by discipline; the `…/opera/{slug}.html`
 *  path is the opera filter. The "under30 preview" / dress-rehearsal variants of a
 *  staged opera are dropped — they double-count the same production. */
async function parseSeasonOperaLinks(seasonUrl: string, ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(seasonUrl, ctx);
  const urls = new Set<string>();
  for (const [, path] of html.matchAll(
    /href="(\/it\/stagione\/\d{4}-\d{4}\/opera\/[^"]+\.html)"/gi,
  )) {
    if (!path || /preview|under30|prova|anteprima/i.test(path)) continue;
    urls.add(`${BASE}${path}`);
  }
  return [...urls];
}

async function buildProduction(
  detailUrl: string,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  const html = await fetchHtml(detailUrl, ctx);

  const composer = parseComposer(html);
  if (!composer) return null;

  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!title) return null;

  const performances = parsePerformances(html, since, today);
  if (performances.length === 0) return null;

  const season = seasonOf(detailUrl);

  return {
    source_production_id: parseSpettacoloId(html) ?? slugFromUrl(detailUrl),
    work_title: title,
    composer_name: composer,
    premiere_season: season,
    detail_url: detailUrl,
    creative_team: parseCreativeTeam(html),
    cast: parseCast(html),
    performances,
  };
}

/** Composer byline sits in `<div class="cnt__subtitle">Giuseppe Verdi</div>`
 *  directly under the title. Its absence marks a non-opera billing → drop. */
function parseComposer(html: string): string | null {
  const m = html.match(/<div class="cnt__subtitle"[^>]*>([\s\S]*?)<\/div>/);
  const name = m ? cleanText(m[1] ?? "") : "";
  return name || null;
}

/** Stable upstream id from the ticketing `spettacolo` query param when present. */
function parseSpettacoloId(html: string): string | null {
  const m = html.match(/spettacolo=(\d+)/);
  return m ? `spettacolo:${m[1]}` : null;
}

function slugFromUrl(url: string): string {
  return (
    url
      .replace(/\.html$/, "")
      .split("/")
      .pop() ?? url
  );
}

/** Creative team: `<th scope="row">Label</th><td>Name</td>` rows in the
 *  `table table-prd` block whose Italian label maps to a canonical function. */
function parseCreativeTeam(html: string): RawCredit[] {
  const block = html.match(/<div class="table table-prd">([\s\S]*?)<\/table>/)?.[1] ?? "";
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const [, rawLabel, rawName] of block.matchAll(
    /<th scope="row">([\s\S]*?)<\/th>\s*<td>([\s\S]*?)<\/td>/g,
  )) {
    const fn = mapFunction(cleanText(rawLabel ?? ""));
    if (!fn) continue;
    for (const person of splitNames(cleanText(rawName ?? ""))) {
      const key = `${fn}|${person}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ function: fn, name: person });
    }
  }
  return out;
}

/** Cast: `<table class="evt">` rows of `<td class="dt">Role</td><td>Singer (8, 12
 *  giu.) / Singer (10, 18 giu.)</td>`. Each singer alternate becomes a cast row
 *  with the per-night date hints stripped. */
function parseCast(html: string): RawCredit[] {
  const table = html.match(/<table class="evt">[\s\S]*?<\/table>/)?.[0] ?? "";
  const out: RawCredit[] = [];
  for (const [, rawRole, rawCell] of table.matchAll(
    /<td class="dt">([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/g,
  )) {
    const role = cleanText(rawRole ?? "");
    if (!role) continue;
    for (const singer of splitCastSingers(cleanText(rawCell ?? ""))) {
      out.push({ role, name: singer });
    }
  }
  return out;
}

/** Performances from `<time class="cal__date" datetime="2026-06-08T20:00:00+02:00">`
 *  slides; the adjacent ticket button's text gives the status. */
function parsePerformances(html: string, since: IsoDate | null, today: string): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const [, slide] of html.matchAll(
    /<div class="swiper-slide">\s*<div class="cal__run">([\s\S]*?)<\/div><\/div>/g,
  )) {
    const iso = slide?.match(/class="cal__date" datetime="([^"]+)"/)?.[1];
    if (!iso || !slide) continue;
    const date = iso.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (since && date < since) continue;
    if (seen.has(`${date}|${iso.slice(11, 16)}`)) continue;
    seen.add(`${date}|${iso.slice(11, 16)}`);
    out.push({
      date: date as IsoDate,
      time: /^\d{2}:\d{2}/.test(iso.slice(11)) ? iso.slice(11, 16) : null,
      venue_room: VENUE,
      status: performanceStatus(slide, date, today),
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

function performanceStatus(slide: string, date: string, today: string): RawPerformance["status"] {
  if (date < today) return "past";
  const text = cleanText(slide).toLowerCase();
  if (/sold out|esaurito/.test(text)) return "sold_out";
  if (/last seats|ultimi posti/.test(text)) return "few_left";
  return "scheduled";
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A creative-credit value may list several people; split on commas / " e ".
 *  Drop ensemble names (orchestra, coro) — not individual performers. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+e\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s));
}

/** A cast cell lists one or more singers, each optionally trailed by its
 *  performance dates in parens ("Vittorio Grigolo (8, 12 giu.)"); alternates are
 *  separated by " / ". Strip the date hints and keep the names. */
function splitCastSingers(cell: string): string[] {
  return cell
    .split(/\s*\/\s*/)
    .map((s) => s.replace(/\s*\([^)]*\)\s*$/, "").trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s));
}

/** Typographic / accented entities the shared `decodeEntities` map omits but
 *  that show up in Italian role and singer names (l'elisir, Dvořák). */
const EXTRA_ENTITIES: Record<string, string> = {
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&scaron;": "š",
  "&Scaron;": "Š",
  "&zcaron;": "ž",
  "&Zcaron;": "Ž",
  "&ccaron;": "č",
  "&Ccaron;": "Č",
};

function cleanText(html: string): string {
  const pre = html.replace(/&[A-Za-z]+;/g, (m) => EXTRA_ENTITIES[m] ?? m);
  return decodeEntities(stripHtml(pre))
    .replace(/[:.]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** La Scala seasons are named by the two calendar years they span (Dec→autumn);
 *  read the `YYYY-YYYY` segment from the detail URL. */
function seasonOf(url: string): string | null {
  return url.match(/\/stagione\/(\d{4}-\d{4})\//)?.[1] ?? null;
}
