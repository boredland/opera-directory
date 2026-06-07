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
 * Teatro La Fenice, Venice (`spielplan-html` strategy). The house plays opera,
 * balletto and concerti (Sinfonica, da camera, jazz) across two venues — the
 * Teatro La Fenice itself and the Teatro Malibran — all listed in one calendar.
 *
 * The site is a WordPress install (The Events Calendar) whose Italian `/event/`
 * detail pages are server-rendered (the JSON-LD is Yoast SEO boilerplate with no
 * dates/cast, and the `wp-json/tribe` REST API 403s, so we parse the SSR HTML).
 * Each season's opera billings are grouped under one taxonomy term whose slug is
 * `opera-{YY}-{YY}` (e.g. `opera-2025-26`); its archive page lists every staged
 * opera as an `<a class="sn_list_lyric_i" href="/event/{slug}/">` card. That
 * category IS the opera filter — balletto, concerti and conferenze live under
 * their own terms — so iterating the opera terms and following only those card
 * links keeps non-opera out. The current term is read off the homepage (robust
 * across the season rollover); backfill walks earlier `opera-{YY}-{YY}` terms
 * back to `window.since` (the terms thin out below ~2023/24).
 *
 * Each opera detail page carries everything inline:
 *   - composer in `<div class="excerpt">` under the `<h1 class="title">`, with the
 *     `<meta name="description">` "{Title} di {Composer}" byline as a fallback for
 *     the older pages whose excerpt is a tagline — REQUIRED (the opera gate);
 *   - performances as `<a class="sn_intro_show_list_items_i">` rows whose ticket
 *     URL carries `&data=YYYYMMDD` and an adjacent `<div class="time">HH:MM</div>`;
 *   - venue in `<div class="location">` (Teatro La Fenice / Teatro Malibran);
 *   - creative team as `label <strong>Name</strong>` lines (split on `<br>`) in
 *     `<div class="sn_text_aside_tx">`, whose ITALIAN labels (direttore, regia,
 *     scene, costumi, luci, …) map to canonical functions in CREATIVE_LABELS;
 *   - cast as the same `role <strong>Singer</strong>` line shape in the
 *     `<div class="sn_block_text">` locandina block.
 *
 * The deep historical archive (`/archivio-storico`) is a separate database not
 * walked here; pre-2023 history comes from Wikidata (Q223942, ~126 works) in
 * backfill mode.
 */

const BASE = "https://www.teatrolafenice.it";
const HOME_URL = `${BASE}/`;
/** Teatro La Fenice on Wikidata — verified via wbsearchentities (it) →
 *  EntityData: Q223942, P31 = opera house (Q153562), P17 = Italy (Q38); 126 works
 *  link via P4647 (premiere here) / P272 (produced here). The sibling theatre
 *  *company* (Q113486506) carries only 2 — Q223942 is the production-bearing one. */
const WIKIDATA_QID = "Q223942";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;
/** Backfill walks opera season terms down to this floor (terms thin out below it). */
const EARLIEST_SEASON_START = 2018;

/**
 * Italian creative-function labels → canonical function keys, tested in order.
 * "Regia" is matched before the set/costume rules because the site combines it
 * ("regia e scene"); chorus-master precedes the generic conductor rule. English
 * equivalents are folded in so the map survives a site-language flip. Unmapped
 * labels (e.g. "riprese da", "movimenti coreografici" handled explicitly) are
 * dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro|chorus master/i, "chorus-master"],
  [/direttore|direzione musicale|maestro concertatore|conductor/i, "conductor"],
  [/regia|staging|director/i, "director"],
  [/coreograf|movimenti coreografici|choreograph/i, "choreographer"],
  [/disegno luci|light designer|^luci\b|^luce\b|lights|lighting/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi|costumes/i, "costume-designer"],
  [/scenografia|^scene\b|^sets?\b|set design/i, "set-designer"],
  [/drammaturgia|dramaturgy/i, "dramaturgy"],
];

export async function scrapeTeatroLaFenice(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const seasonSlugs = await discoverOperaSeasons(ctx, window);

    const detailUrls = new Set<string>();
    for (const slug of seasonSlugs) {
      try {
        for (const url of await parseSeasonOperaLinks(slug, ctx)) detailUrls.add(url);
      } catch (err) {
        console.warn(`teatro-la-fenice: season ${slug} failed:`, err);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const detailUrl of detailUrls) {
      try {
        const prod = await buildProduction(detailUrl, ctx, since, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-la-fenice: ${detailUrl} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-la-fenice: season scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-la-fenice: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-la-fenice", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/**
 * The opera taxonomy term slugs to walk. Incremental reads the current term off
 * the homepage (`opera-{YY}-{YY}`); backfill additionally synthesizes earlier
 * terms down to the `window.since` season (or EARLIEST_SEASON_START), since the
 * archive pages don't link the whole back-catalogue.
 */
async function discoverOperaSeasons(ctx: FetchContext, window: ScrapeWindow): Promise<string[]> {
  const html = await fetchHtml(HOME_URL, ctx);
  const slugs = new Set<string>();
  for (const [, slug] of html.matchAll(/event-category\/(opera-\d{4}-\d{2})\b/gi)) {
    if (slug) slugs.add(slug);
  }
  if (slugs.size === 0) slugs.add(currentSeasonSlug());

  if (window.mode === "backfill") {
    const floor = window.since
      ? Number.parseInt(window.since.slice(0, 4), 10)
      : EARLIEST_SEASON_START;
    const latest = Math.max(...[...slugs].map((s) => Number.parseInt(s.slice(6, 10), 10)));
    for (let start = latest; start >= floor; start--) slugs.add(seasonSlug(start));
  }
  return [...slugs];
}

function currentSeasonSlug(): string {
  const now = new Date();
  const start = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return seasonSlug(start);
}

function seasonSlug(start: number): string {
  return `opera-${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** A season term's archive page lists each staged opera as an
 *  `<a class="sn_list_lyric_i" href="/event/{slug}/">` card; collect those links. */
async function parseSeasonOperaLinks(seasonSlug: string, ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(`${BASE}/event-category/${seasonSlug}/`, ctx);
  const urls = new Set<string>();
  for (const [, href] of html.matchAll(
    /<a\s+href="(https:\/\/www\.teatrolafenice\.it\/event\/[^"]+)"\s+class="sn_list_lyric_i/gi,
  )) {
    if (href) urls.add(href);
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

  const title = cleanText(html.match(/<h1 class="title">\s*<span>([\s\S]*?)<\/span>/)?.[1] ?? "");
  if (!title) return null;

  const composer = parseComposer(html, title);
  if (!composer) return null;

  const performances = parsePerformances(html, since, today);
  if (performances.length === 0) return null;

  return {
    source_production_id: slugFromUrl(detailUrl),
    work_title: title,
    composer_name: composer,
    premiere_season: parseSeason(html),
    detail_url: detailUrl,
    image_url: parseImage(html),
    ...parseCredits(html),
    performances,
  };
}

/**
 * Composer = the `<div class="excerpt">` byline under the title when it reads as
 * a person name (the current-season pages put the composer there verbatim,
 * including "/"-joined double bills). Older pages reuse the excerpt for a tagline
 * ("Serata inaugurale …"); for those, fall back to the `<meta name="description">`
 * "{Title} di {Composer} - …" / "… musica di {Composer}" byline. Returns null
 * when no composer can be resolved → the billing is dropped (the opera gate).
 */
function parseComposer(html: string, title: string): string | null {
  const excerpt = cleanText(html.match(/<div class="excerpt">([\s\S]*?)<\/div>/)?.[1] ?? "");
  if (excerpt && looksLikeComposer(excerpt)) return excerpt;

  const desc = decodeEntities(
    html.match(/<meta name="description" content="([^"]*)"/i)?.[1] ?? "",
  ).trim();
  const fromMusica = desc.match(/musica di\s+([^,.\-–—]+)/i);
  if (fromMusica?.[1] && looksLikeComposer(cleanText(fromMusica[1])))
    return cleanText(fromMusica[1]);
  const fromDi = desc.match(/\bdi\s+([^,.\-–—]+?)(?:\s*[-–—]|,|$)/i);
  if (fromDi?.[1] && looksLikeComposer(cleanText(fromDi[1]))) return cleanText(fromDi[1]);

  // Last resort: a clean excerpt that didn't pass the name heuristic but isn't a
  // sentence (single short capitalized phrase) is taken as printed.
  if (excerpt && excerpt.length <= 60 && !/\b(serata|stagione|allestimento|nuovo)\b/i.test(excerpt))
    return excerpt;
  void title;
  return null;
}

/** One-or-more capitalized name tokens (allowing "/" double bills, " & ", " e "),
 *  rejecting taglines that read as a sentence (lowercase connectives, form words). */
function looksLikeComposer(text: string): boolean {
  const segments = text.split(/\s*[/&]\s*|\s+e\s+/).map((s) => s.trim());
  return (
    segments.length > 0 &&
    segments.every((seg) => /^[A-ZÀ-Ý][a-zà-ÿ.'’-]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ.'’-]+){0,3}$/.test(seg))
  );
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}

function parseImage(html: string): string | null {
  return html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1] ?? null;
}

/** Performances from `<a class="sn_intro_show_list_items_i" href="…&data=YYYYMMDD">`
 *  rows; the date rides in the ticket URL's `data` param and the time in the
 *  adjacent `<div class="time">HH:MM</div>`. */
function parsePerformances(html: string, since: IsoDate | null, today: string): RawPerformance[] {
  const venue = parseVenue(html);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /href="([^"]*?)"\s+class="sn_intro_show_list_items_i[^"]*">([\s\S]*?)<\/a>/gi,
  )) {
    const href = m[1] ?? "";
    const inner = m[2] ?? "";
    const ymd = href.match(/[?&]data=(\d{8})/)?.[1];
    if (!ymd) continue;
    const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (since && date < since) continue;
    const time = inner.match(/<div class="time">\s*(\d{1,2}[:.]\d{2})/)?.[1]?.replace(".", ":");
    const hhmm = time ? time.padStart(5, "0") : null;
    const key = `${date}|${hhmm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date: date as IsoDate,
      time: hhmm,
      venue_room: venue,
      ticket_url: /^https?:/i.test(href) ? decodeEntities(href) : null,
      status: date < today ? "past" : "scheduled",
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/** Venue is the first `<div class="location">…Teatro …</div>` on the page. */
function parseVenue(html: string): string | null {
  const raw = html.match(/<div class="location">([\s\S]*?)<\/div>/)?.[1] ?? "";
  const name = cleanText(
    raw.replace(/<svg[\s\S]*?<\/svg>/gi, "").replace(/<span[\s\S]*?<\/span>/gi, ""),
  );
  return name || null;
}

/**
 * Both credit kinds live in `label <strong>Name</strong>` lines. The layout
 * varies: some pages split the creative team into the `sn_text_aside_tx` body and
 * the cast into the `sn_block_text` locandina; others list both (direttore, regia
 * AND the role→singer rows) in the locandina alone. We parse both blocks and let
 * the label decide: a row whose Italian label maps to a creative function is a
 * creative credit; everything else is a sung role → cast. The `sn_text_aside_tx`
 * body also carries the production's prose synopsis, whose emphasised words sit in
 * `<strong>` runs with no leading label — those yield no pair and are dropped.
 */
function parseCredits(html: string): {
  creative_team: RawCredit[];
  cast: RawCredit[];
} {
  const blocks = [
    html.match(/sn_text_aside_tx">([\s\S]*?)<\/div>\s*<div class="col/i)?.[1] ?? "",
    html.match(/sn_block_text[^"]*">\s*<div>([\s\S]*?)<\/div>/i)?.[1] ?? "",
  ];

  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const block of blocks) {
    for (const { label, name } of labelStrongLines(block)) {
      const fn = mapFunction(label);
      if (fn) {
        for (const person of splitNames(name)) {
          const key = `${fn}|${person}`;
          if (seenCreative.has(key)) continue;
          seenCreative.add(key);
          creative.push({ function: fn, name: person });
        }
      } else if (looksLikeRole(label)) {
        for (const singer of splitNames(name)) {
          const key = `${label}|${singer}`;
          if (seenCast.has(key)) continue;
          seenCast.add(key);
          cast.push({ role: label, name: singer });
        }
      }
    }
  }
  return { creative_team: creative, cast };
}

/** Production-staff labels with no canonical credit function — assistants, revival
 *  supervisors, video/dramaturgy hands. They aren't sung roles, so they're dropped
 *  rather than misfiled as cast. */
const NON_ROLE_LABELS =
  /riprese|ripresa|assistente|maestr|drammaturg|video|movimenti|aiuto|collabora|sopratitoli|regista|allest|durata|interval/i;

/** A role label is a short character name, not a synopsis fragment or a staff
 *  label. Reject long emphasised phrases from the prose body, known staff terms,
 *  and bare Italian articles (a prose line whose first bolded word is "La …"). */
function looksLikeRole(label: string): boolean {
  if (label.length > 40 || label.split(/\s+/).length > 5) return false;
  if (NON_ROLE_LABELS.test(label)) return false;
  if (/^(il|lo|la|i|gli|le|un|uno|una|l)$/i.test(label)) return false;
  return true;
}

/**
 * Parse `label <strong>Name</strong>` lines. The markup is irregular: `<span>`
 * wrappers split labels off their names ("scene e costumi" in a span, the name in
 * the next `<strong>`) and a stray `<br>` sometimes sits *inside* the bold run
 * ("<strong>Bepi Morassi<br /></strong>"). We first drop `<span>` tags and hoist
 * any `<br>` out of `</strong>`, then split on `<br>` so each line reads
 * "label <strong>name</strong>": the value is the bold run, the label the plain
 * text before it. Lines with no bold run (ensemble lines like "Orchestra e Coro
 * del Teatro La Fenice") yield no pair and are skipped.
 */
function labelStrongLines(html: string): { label: string; name: string }[] {
  const normalized = html
    .replace(/<\/?span[^>]*>/gi, "")
    .replace(/<br\s*\/?>(\s*)<\/strong>/gi, "</strong>$1<br/>")
    .replace(/<\/p>|<p[^>]*>/gi, "<br/>");
  const rows: { label: string; name: string }[] = [];
  for (const line of normalized.split(/<br\s*\/?>/i)) {
    const strong = line.match(/<strong>([\s\S]*?)<\/strong>/i);
    if (!strong) continue;
    const name = cleanText(strong[1] ?? "");
    const label = cleanLabel(line.slice(0, line.indexOf(strong[0])));
    if (label && name) rows.push({ label, name });
  }
  return rows;
}

function cleanLabel(html: string): string {
  return cleanText(html)
    .replace(/[:.]\s*$/, "")
    .trim();
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A credit value may list several people; split on commas / " e ". Drop ensemble
 *  names (orchestra, coro) — they aren't individual performers we model. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+e\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s));
}

/** Season from the opera category link on the page (`opera-2025-26` → "2025/26"). */
function parseSeason(html: string): string | null {
  const m = html.match(/event-category\/opera-(\d{4})-(\d{2})\b/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Typographic / accented entities the shared `decodeEntities` map omits but that
 *  show up in Italian role and singer names (l'elisir, Dvořák). */
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
  return decodeEntities(stripHtml(pre)).replace(/\s+/g, " ").trim();
}
