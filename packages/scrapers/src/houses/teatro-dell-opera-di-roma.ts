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
 * Teatro dell'Opera di Roma (`spielplan-html` strategy). The fondazione lirica
 * plays opera, balletto and concerti across the Teatro Costanzi (its main house)
 * and a summer open-air season historically at the Terme di Caracalla — recently
 * also the Circo Massimo. All three disciplines and both venues share one
 * cartellone.
 *
 * The site is a WordPress (WPML) install whose season page is a client-side SPA,
 * but its data feed is a server-rendered HTML fragment from one admin-ajax action
 * — `…/admin-ajax.php?action=stagione&lang=it` — that returns EVERY show of every
 * season (2018→) as `<li class="spettacolo">` cards. There is no JSON-LD and no
 * REST endpoint for the `shows` post type, so we parse that fragment plus the
 * per-show detail pages.
 *
 * The opera gate is twofold and cheap: each card carries its discipline in a
 * `<div class="terms">` (Italian `Opere` for staged opera, vs Balletti / Concerti
 * / Pop / Tournée …) AND its composer verbatim in `<div class="musica-di">`. We
 * keep only `Opere` cards that resolve a composer; the discipline term drops
 * balletto/concerto/danza/recital and the composer requirement drops the rare
 * opera-tagged billing with no byline. The feed has no per-card year, so the
 * season window is applied from the card's `<div class="date">… YYYY</div>` range.
 *
 * Each detail page (`/spettacoli/{slug}/`) carries everything inline:
 *   - composer: `<div class="subtitle-1">` "Musica di {X}" byline (fallback to the
 *     listing's `musica-di`); title in `<h1 class="entry-title post-title">`;
 *   - creative team: a structured top of `<h4>Label</h4> <span class="persone">…`
 *     pairs (Direttore, Regia) plus a free-text body of "Label <strong>Name</strong>"
 *     runs (Scene, Costumi, Luci, Maestro del Coro, …), both mapped through
 *     CREATIVE_LABELS; the cast (role → singer, with per-night day-number hints) is
 *     too irregular in that body to parse reliably, so cast is left empty;
 *   - performances: `<ul class="datelist">` of `<li>` rows with `.giorno` (day),
 *     `.mese` (Italian 3-letter month) and an "ORE HH:MM" time but NO year — the
 *     year is taken from the listing card's date range (which is authoritative; the
 *     `stagione-show` label lags, tagging the autumn opener under the old season);
 *   - venue: the second `<h3>` in the `widget_dove` block (Teatro Costanzi /
 *     Terme di Caracalla / Circo Massimo).
 *
 * The feed reaches ~2018; deeper history comes from Wikidata (Q1050350) in
 * backfill mode.
 */

const BASE = "https://www.operaroma.it";
const FEED_URL = `${BASE}/wp-admin/admin-ajax.php?action=stagione&lang=it`;
/** Teatro dell'Opera di Roma on Wikidata — verified via wbsearchentities (it):
 *  two entities share the label, the opera-house building Q1050350 (P31 = opera
 *  house Q24354, P17 = Italy Q38) and the theatre *company* Q113486288. The
 *  building is the production-bearing one: 64 works link via P4647 (premiere here)
 *  vs the company's 2 P272. So Q1050350. */
const WIKIDATA_QID = "Q1050350";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;
/** Backfill floor when `window.since` is unbounded — the feed thins out below it. */
const EARLIEST_FEED_YEAR = 2018;

/** The Italian discipline term that marks a staged opera. Balletti / Concerti /
 *  Pop / Tournée / Off / Extra / Teatro Digitale are dropped. "Caracalla Festival"
 *  and "Circo Massimo" are venue terms that co-occur with the discipline, not
 *  disciplines themselves. */
const OPERA_TERM = "Opere";

/**
 * Italian creative-function labels → canonical function keys, tested in order.
 * "Regia" is matched before the set/costume rules because the site combines it
 * ("Regia e scene"); chorus-master precedes the generic conductor rule. English
 * equivalents from the `/en/` mirror are folded in so the map survives a
 * site-language flip. Unmapped labels (Video, Aiuto regia, …) are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro|chorus master/i, "chorus-master"],
  [/direttore|direzione musicale|maestro concertatore|conductor/i, "conductor"],
  [/regia|staging|director/i, "director"],
  [/coreograf|choreograph/i, "choreographer"],
  [/disegno luci|^luci\b|^luce\b|lights|lighting/i, "lighting"],
  [/scene e costumi|scene, costumi/i, "set-designer"],
  [/^costumi|costumes/i, "costume-designer"],
  [/scenografia|^scene\b|^sets?\b|set design/i, "set-designer"],
  [/drammaturgia|dramaturgy/i, "dramaturgy"],
];

/** Italian 3-letter month abbreviations as printed in the `.mese` cells. */
const MONTHS: Record<string, number> = {
  gen: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  mag: 5,
  giu: 6,
  lug: 7,
  ago: 8,
  set: 9,
  ott: 10,
  nov: 11,
  dic: 12,
};

/** Full Italian month names as printed in the listing card's date range; the
 *  3-letter prefix matches the `MONTHS` abbreviations used in the date cells. */
const FULL_MONTH_RE =
  /(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/gi;

interface FeedCard {
  detailUrl: string;
  title: string;
  composer: string | null;
  /** Calendar years the card's date range spans, for the season filter. */
  years: number[];
  /** Authoritative month→year map from the card's date range. The detail page's
   *  `stagione-show` label lags (it tags the next autumn under the old season), so
   *  the listing year is trusted over a season-derived one. */
  monthYears: Map<number, number>;
}

export async function scrapeTeatroDellOperaDiRoma(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const sinceYear = since ? Number.parseInt(since.slice(0, 4), 10) : EARLIEST_FEED_YEAR;
    const today = new Date().toISOString().slice(0, 10);

    const cards = parseFeed(await fetchHtml(FEED_URL, ctx)).filter((c) =>
      c.years.some((y) => y >= sinceYear),
    );

    for (const card of cards) {
      try {
        const prod = await buildProduction(card, ctx, since, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-dell-opera-di-roma: ${card.detailUrl} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-dell-opera-di-roma: season feed scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-dell-opera-di-roma: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-dell-opera-di-roma", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** Parse the admin-ajax fragment into one card per `<li class="spettacolo">`,
 *  keeping only those tagged with the `Opere` discipline term. */
function parseFeed(html: string): FeedCard[] {
  const out: FeedCard[] = [];
  for (const block of html.split('<li class="spettacolo">').slice(1)) {
    if (!cardTerms(block).includes(OPERA_TERM)) continue;
    const detailUrl = block.match(/<a class="title" href="([^"]+)"/)?.[1];
    const title = cleanText(block.match(/<a class="title"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
    if (!detailUrl || !title) continue;
    const dateText = decodeEntities(block.match(/<div class="date">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const monthYears = cardMonthYears(dateText);
    out.push({
      detailUrl,
      title,
      composer:
        cleanText(block.match(/<div class="musica-di">([\s\S]*?)<\/div>/)?.[1] ?? "") || null,
      years: [...new Set(monthYears.values())],
      monthYears,
    });
  }
  return out;
}

/** The discipline/venue tags from a card's `<div class="terms">…<a>Label</a>…`. */
function cardTerms(block: string): string[] {
  const terms = block.match(/<div class="terms">([\s\S]*?)<\/div>/)?.[1] ?? "";
  return [...terms.matchAll(/>([^<]+)<\/a>/g)].map(([, t]) => cleanText(t ?? ""));
}

/**
 * Map each month a card's date range touches to its calendar year. The range is
 * "{day} {Month} [{year}] - {day} {Month} {year}" with the year usually printed
 * once at the end ("13 Gennaio - 25 Gennaio 2026") and occasionally at both ends
 * across a December→January rollover ("30 Dicembre 2025 - 7 Gennaio 2026"). We pair
 * each month token with the next year token to its right; a leading month with no
 * year of its own inherits the end year, unless its month number is greater than
 * the end month (a rollover), in which case it belongs to the prior year.
 */
function cardMonthYears(dateText: string): Map<number, number> {
  const months = [...dateText.matchAll(FULL_MONTH_RE)].map((m) => ({
    month: MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()] ?? 0,
    index: m.index ?? 0,
  }));
  const years = [...dateText.matchAll(/\b(20\d{2})\b/g)].map((m) => ({
    year: Number.parseInt(m[1] ?? "", 10),
    index: m.index ?? 0,
  }));
  const out = new Map<number, number>();
  if (!months.length || !years.length) return out;

  const endYear = years[years.length - 1]?.year ?? 0;
  for (const { month, index } of months) {
    if (!month) continue;
    const ownYear = years.find((y) => y.index > index)?.year;
    const lastMonth = months[months.length - 1]?.month ?? month;
    const year = ownYear ?? (month > lastMonth ? endYear - 1 : endYear);
    if (year) out.set(month, year);
  }
  return out;
}

async function buildProduction(
  card: FeedCard,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  const html = await fetchHtml(card.detailUrl, ctx);

  const composer = card.composer ?? parseComposer(html);
  if (!composer) return null;

  const title =
    cleanText(html.match(/<h1 class="entry-title post-title">([\s\S]*?)<\/h1>/)?.[1] ?? "") ||
    card.title;
  if (!title) return null;

  const season = parseSeason(html);
  const performances = parsePerformances(html, card.monthYears, season, since, today);
  if (performances.length === 0) return null;

  return {
    source_production_id: slugFromUrl(card.detailUrl),
    work_title: title,
    composer_name: composer,
    premiere_season: season,
    detail_url: card.detailUrl,
    image_url: html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1] ?? null,
    creative_team: parseCreativeTeam(html),
    cast: [],
    performances,
  };
}

/** Composer fallback from the detail page's `<div class="subtitle-1">` "Musica di
 *  {X}" byline (the Circo Massimo summer pages drop the "di" → "Musica {X}"); the
 *  name may sit inside or after a `<strong>`, so we read it off the stripped text. */
function parseComposer(html: string): string | null {
  const block = html.match(/<div class="subtitle-1">([\s\S]*?)<\/div>/)?.[1] ?? "";
  const m = stripHtml(block).match(
    /\bmusica(?:\s+di)?\s+([^,.\n]+?)(?:\s+(?:opera|scene|libretto|da)\b|$)/i,
  );
  return m ? cleanText(m[1] ?? "") || null : null;
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}

/** Season string from `<div class="stagione-show">Stagione 2025/2026</div>`. */
function parseSeason(html: string): string | null {
  const m = html.match(/class="stagione-show">[^<]*?(\d{4})\/(\d{4})/);
  return m ? `${m[1]}/${(m[2] ?? "").slice(2)}` : null;
}

/**
 * Creative team from the `.ruoli` block, in two zones:
 *   - structured `<h4>Label</h4> <span class="persone">…<a>Name</a>…</span>` pairs
 *     (Direttore, Regia);
 *   - a free-text body of "Label <strong>Name</strong>" runs (Scene/Costumi/Luci,
 *     Maestro del Coro, …).
 * Both label kinds map through CREATIVE_LABELS; unmapped labels are dropped. The
 * cast (role → singer) shares the free-text body but in an irregular, multi-`<p>`
 * shape with per-night day numbers that doesn't parse reliably, so it's omitted.
 */
function parseCreativeTeam(html: string): RawCredit[] {
  const block = html.match(/class="ruoli">([\s\S]*?)<div class="arrow-bottom"/)?.[1] ?? "";
  const out: RawCredit[] = [];
  const seen = new Set<string>();

  const add = (label: string, rawNames: string): void => {
    const fn = mapFunction(label);
    if (!fn) return;
    for (const person of splitNames(rawNames)) {
      const key = `${fn}|${person}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ function: fn, name: person });
    }
  };

  for (const [, label, names] of block.matchAll(
    /<h4>([\s\S]*?)<\/h4>\s*<span class="persone">([\s\S]*?)<\/span>/g,
  )) {
    add(cleanLabel(label ?? ""), cleanText(stripStrongDates(names ?? "")));
  }

  const body = block.replace(/<h4>[\s\S]*?<\/span>/g, "");
  for (const line of labelStrongLines(body)) add(line.label, line.name);

  return out;
}

/** Parse "Label <strong>Name</strong>" runs from the free-text `.ruoli` body. The
 *  cast block ("PERSONAGGI e INTERPRETI" onward) is cut first — its role→singer
 *  lines aren't creative credits and aren't reliably structured. */
function labelStrongLines(html: string): { label: string; name: string }[] {
  const head = html.split(/PERSONAGGI|CHARACTERS AND CAST|INTERPRETI/i)[0] ?? html;
  const normalized = head
    .replace(/<br\s*\/?>(\s*)<\/strong>/gi, "</strong>$1<br/>")
    .replace(/<\/p>|<p[^>]*>/gi, "<br/>");
  const rows: { label: string; name: string }[] = [];
  for (const segment of normalized.split(/<br\s*\/?>/i)) {
    const strong = segment.match(/<strong>([\s\S]*?)<\/strong>/i);
    if (!strong) continue;
    const name = cleanText(strong[1] ?? "");
    const label = cleanLabel(segment.slice(0, segment.indexOf(strong[0])));
    if (label && name) rows.push({ label, name });
  }
  return rows;
}

/**
 * Performances from `<ul class="datelist">` rows: `.giorno` (day), `.mese`
 * (Italian month abbrev) and an "ORE HH:MM" time. The date cells print no year, so
 * each month is resolved against the listing card's date range (`monthYears`),
 * which is authoritative; only when the card omits the month do we fall back to the
 * season span (autumn months Sep–Dec in the first calendar year, the rest in the
 * second — a Jan date in "2025/26" → 2026).
 */
function parsePerformances(
  html: string,
  monthYears: Map<number, number>,
  season: string | null,
  since: IsoDate | null,
  today: string,
): RawPerformance[] {
  const years = seasonYears(season);
  const venue = parseVenue(html);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, li] of html.matchAll(/<li class="[^"]*">([\s\S]*?)<\/li>/g)) {
    const day = li?.match(/<div class="giorno">\s*(\d{1,2})\s*<\/div>/)?.[1];
    const monRaw = li?.match(/<div class="mese">\s*([A-Za-zÀ-ÿ]+)\s*<\/div>/)?.[1];
    if (!day || !monRaw) continue;
    const month = MONTHS[monRaw.slice(0, 3).toLowerCase()];
    if (!month) continue;
    const year = monthYears.get(month) ?? (month >= 9 ? years.first : years.second);
    if (!year) continue;
    const date = `${year}-${pad(month)}-${pad(Number(day))}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (since && date < since) continue;
    const time = li?.match(/(?:ORE|HOURS)\s*(\d{1,2}[:.]\d{2})/i)?.[1]?.replace(".", ":") ?? null;
    const hhmm = time ? pad2(time) : null;
    const key = `${date}|${hhmm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date: date as IsoDate,
      time: hhmm,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/** The two calendar years a "YYYY/YY" season spans. */
function seasonYears(season: string | null): { first: number | null; second: number | null } {
  const m = season?.match(/^(\d{4})\/(\d{2})$/);
  if (!m) return { first: null, second: null };
  const first = Number.parseInt(m[1] ?? "", 10);
  return { first, second: Math.floor(first / 100) * 100 + Number.parseInt(m[2] ?? "", 10) };
}

/** Venue = the second `<h3>` in `widget_dove` (the first is the widget title
 *  "Dove"): Teatro Costanzi / Terme di Caracalla / Circo Massimo. */
function parseVenue(html: string): string | null {
  const m = html.match(/widget_dove[\s\S]*?<h3>[^<]*<\/h3>[\s\S]*?<h3>([^<]+)<\/h3>/);
  return m ? cleanText(m[1] ?? "") || null : null;
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A creative-credit value may list several people (separated by commas / " e ")
 *  and trail per-night day numbers in parens; drop ensemble names and the hints. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+e\s+/)
    .map((s) => s.replace(/\s*\([^)]*\)\s*$/, "").trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s));
}

/** Strip the day-number hints a `.persone` link sometimes carries inside its
 *  anchor text ("Alessandro Palumbo (21)"). */
function stripStrongDates(html: string): string {
  return html.replace(/\([\d,\s]+\)/g, " ");
}

function cleanLabel(html: string): string {
  return cleanText(html)
    .replace(/[:.]\s*$/, "")
    .trim();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function pad2(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  return `${(h ?? "").padStart(2, "0")}:${m ?? "00"}`;
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
