import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchJson, stripHtml } from "../fetch";
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
 * Teatro Regio di Parma (`json-api` strategy) — the Parma teatro di tradizione,
 * home of the autumn Festival Verdi. The site is a block-theme WordPress install
 * (LiteSpeed) that exposes its custom `show` post type over the public WP REST
 * API at `/wp-json/wp/v2/show`, with a `show-category` taxonomy that segregates
 * the cartellone (Opera, Festival Verdi, Concerti, Parma Danza, Regio Young, …).
 * We pull the staged-opera strands — the durable `opera` and `festival-verdi`
 * terms plus their per-season variants (`stagione-{NN}-opera`,
 * `edizione-{NN}-festival-verdi`) — and parse each show's `content.rendered`
 * block markup, since the REST payload carries no structured composer/date/cast.
 *
 * Each show page is uniform Gutenberg markup:
 *   - composer from the spettacolo block's "Musica <strong>{Composer}</strong>"
 *     byline, falling back to the `<div class="subtitle"><p>{Composer}</p></div>`
 *     under the H1 — REQUIRED, and only when it reads as a person name (part of
 *     the opera gate; the byline is authoritative — it fixes subtitle typos like
 *     "Vicenzo Bellini" → "Vincenzo Bellini");
 *   - performances in the header `<ul class="dates">` ("{D}<br>{mon}<br>{YYYY}"),
 *     the only source carrying the year; times come from the `show-date` rows
 *     ("{dow} {D} {mon}" + an `icon-time` "HH:MM"), matched back on day+month;
 *   - creative team as "label <strong>Name</strong>" lines (split on `<br>`)
 *     whose ITALIAN labels (direttore, regia, scene, costumi, luci, maestro del
 *     coro, …) map to canonical functions in CREATIVE_LABELS;
 *   - cast in `<div class="profile">…{Role}<br><b>{Singer}</b></div>` cards.
 *
 * The opera/festival terms still carry non-staged billings (open rehearsals,
 * pre-show talks, study days, galas, concerts, dance/contemporary series). The
 * gate is the reference pattern (La Scala / Arena): REQUIRE a person-name
 * composer AND a sung character cast. Concerts/galas/series fail one or both —
 * they have a programme-title subtitle ("Ramificazioni") or no cast cards. Deep
 * history beyond the live REST set comes from Wikidata (Q2096472, 31 works) in
 * backfill mode.
 */

const BASE = "https://teatroregioparma.it";
const SHOW_API = `${BASE}/wp-json/wp/v2/show`;
const CATEGORY_API = `${BASE}/wp-json/wp/v2/show-category`;
const VENUE = "Teatro Regio di Parma";
/** Teatro Regio di Parma on Wikidata — verified via wbsearchentities (it):
 *  Q2096472, P31 = opera house (Q153562) + building (Q24354), P17 = Italy (Q38).
 *  31 works link to it via P4647 (premiere here) / P272 (produced here). */
const WIKIDATA_QID = "Q2096472";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/**
 * Italian creative-function labels → canonical function keys, tested in order.
 * "Regia" precedes the set/costume rules because the site combines it ("regia e
 * scene"); chorus-master precedes the generic conductor rule. Unmapped labels
 * (allestimento, coproduzione, sopratitoli, libretto, …) are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro/i, "chorus-master"],
  [/direttore|direzione musicale|maestro concertatore/i, "conductor"],
  [/regia|regista/i, "director"],
  [/coreograf/i, "choreographer"],
  [/disegno luci|^luci\b|^luce\b/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi/i, "costume-designer"],
  [/scenografia|^scene\b/i, "set-designer"],
  [/drammaturgia/i, "dramaturgy"],
];

/** Voice-type / instrument "roles" mark a concert or sacred-work billing (the
 *  Verdi Requiem → Soprano/Mezzo/Tenore/Basso), not a staged character. A cast of
 *  only these fails the opera gate. */
const NON_CHARACTER_ROLES =
  /^(soprano|mezzosoprano|mezzo-soprano|contralto|tenore|baritono|basso|controtenore|voce recitante|coro|violino|viola|violoncello|pianoforte)$/i;

/** Title keywords for non-staged billings (galas, concerts, recitals, study days)
 *  that can still carry character-role-shaped cast cards; dropped by title. */
const NON_STAGED_TITLE = /\b(gala|concerto|recital|conferenza|giornata di studi)\b/i;

/** Italian month abbreviations as printed in the header date list → month number. */
const MONTHS: Record<string, string> = {
  gen: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  mag: "05",
  giu: "06",
  lug: "07",
  ago: "08",
  set: "09",
  ott: "10",
  nov: "11",
  dic: "12",
};

interface WpTerm {
  id: number;
  slug: string;
}

interface WpShow {
  id: number;
  slug?: string | null;
  link?: string | null;
  title?: { rendered?: string } | null;
  content?: { rendered?: string } | null;
}

export async function scrapeTeatroRegioDiParma(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);
    const shows = await fetchOperaShows(ctx);

    for (const show of shows) {
      try {
        const prod = buildProduction(show, since, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-regio-di-parma: ${show.slug ?? show.id} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-regio-di-parma: cartellone scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-regio-di-parma: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-regio-di-parma", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/**
 * Every `show` under an opera strand, deduped by id. The opera strands are the
 * `show-category` terms whose slug is the durable `opera`/`festival-verdi` term
 * or a per-season variant (`stagione-{NN}-opera`, `edizione-{NN}-festival-verdi`)
 * — resolved at runtime from the taxonomy so a term-id reshuffle can't break it.
 */
async function fetchOperaShows(ctx: FetchContext): Promise<WpShow[]> {
  const terms = await fetchJson<WpTerm[]>(`${CATEGORY_API}?per_page=100`, ctx);
  const operaTermIds = terms
    .filter((t) => /(^|-)opera$|festival-verdi$/.test(t.slug))
    .map((t) => t.id);

  const byId = new Map<number, WpShow>();
  for (const termId of operaTermIds) {
    try {
      const shows = await fetchJson<WpShow[]>(
        `${SHOW_API}?show-category=${termId}&per_page=100&_fields=id,slug,link,title,content`,
        ctx,
      );
      for (const show of shows) byId.set(show.id, show);
    } catch (err) {
      console.warn(`teatro-regio-di-parma: term ${termId} failed:`, err);
    }
  }
  return [...byId.values()];
}

function buildProduction(show: WpShow, since: IsoDate | null, today: string): RawProduction | null {
  const html = show.content?.rendered ?? "";
  const title = cleanText(show.title?.rendered ?? "");
  if (!title || NON_STAGED_TITLE.test(title)) return null;

  const composer = parseComposer(html);
  if (!composer) return null;

  const performances = parsePerformances(html, since, today);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html);
  // No sung character role ⇒ a concert or sacred-work billing sharing the
  // opera/festival term (voice-type-only cast) — drop (the opera gate, mirroring
  // La Scala / Arena).
  if (!cast.some((c) => c.role && !NON_CHARACTER_ROLES.test(c.role))) return null;

  const detailUrl = show.link ?? (show.slug ? `${BASE}/spettacolo/${show.slug}/` : null);

  return {
    source_production_id: show.slug ?? String(show.id),
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: detailUrl,
    creative_team,
    cast,
    performances,
  };
}

/**
 * Composer from the spettacolo block's "Musica <strong>…</strong>" byline
 * (authoritative — it carries the correct spelling), falling back to the
 * `<div class="subtitle"><p>…</p></div>` under the H1. Returns null unless the
 * value reads as a person name, which drops programme-title subtitles
 * ("Ramificazioni", "Mondi Lontani") and date-phrase gala billings.
 */
function parseComposer(html: string): string | null {
  const musica = cleanText(html.match(/Musica\s*<strong>([\s\S]*?)<\/strong>/i)?.[1] ?? "");
  if (musica && looksLikeComposer(musica)) return musica;
  const subtitle = cleanText(html.match(/<div class="subtitle">\s*<p>([\s\S]*?)<\/p>/i)?.[1] ?? "");
  if (subtitle && looksLikeComposer(subtitle)) return subtitle;
  return null;
}

/** One-or-more capitalized name tokens (allowing "/" double bills, " e "),
 *  rejecting programme titles and date phrases that read as a sentence. */
function looksLikeComposer(text: string): boolean {
  const segments = text.split(/\s*\/\s*|\s+e\s+/).map((s) => s.trim());
  return (
    segments.length > 0 &&
    segments.every((seg) => /^[A-ZÀ-Ý][a-zà-ÿ.'’-]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ.'’-]+){0,3}$/.test(seg))
  );
}

/**
 * Performances from the header `<ul class="dates">` — the only source carrying
 * the year ("{D}<br>{mon}<br>{YYYY}"). Times come from the `show-date` rows
 * ("{dow} {D} {mon}" + an adjacent `icon-time` "HH:MM"), matched back on the
 * day+month key since those rows omit the year.
 */
function parsePerformances(html: string, since: IsoDate | null, today: string): RawPerformance[] {
  const times = parseShowDateTimes(html);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const ul = html.match(/<ul class="dates[^"]*">([\s\S]*?)<\/ul>/i)?.[1] ?? "";
  for (const [, li] of ul.matchAll(/<li class="date">([\s\S]*?)<\/li>/gi)) {
    const parts = stripHtml(li ?? "")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const [day, mon, year] = parts;
    const month = mon ? MONTHS[mon.toLowerCase()] : undefined;
    if (!day || !month || !year || !/^\d{4}$/.test(year)) continue;
    const date = isoFromParts(year, month, day);
    if (!date) continue;
    if (since && date < since) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({
      date,
      time: times.get(`${day.padStart(2, "0")}|${month}`) ?? null,
      venue_room: VENUE,
      status: date < today ? "past" : "scheduled",
    });
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/** Map each `show-date` row's day+month to its start time. The rows read
 *  "{dow} {D} {mon}" (no year) with an adjacent `icon-time` "HH:MM"; the key is
 *  "{DD}|{MM}" so a header date can look its time up. */
function parseShowDateTimes(html: string): Map<string, string> {
  const times = new Map<string, string>();
  for (const [, dateText, timeText] of html.matchAll(
    /icon-calendar"><\/span>([\s\S]*?)<\/div>[\s\S]*?icon-time"><\/span>([\s\S]*?)<\/div>/gi,
  )) {
    const m = stripHtml(dateText ?? "").match(/(\d{1,2})\s+([a-zà-ÿ]{3,})/i);
    const month = m?.[2] ? MONTHS[m[2].slice(0, 3).toLowerCase()] : undefined;
    const time = stripHtml(timeText ?? "").match(/(\d{1,2}:\d{2})/)?.[1];
    if (!m?.[1] || !month || !time) continue;
    times.set(`${m[1].padStart(2, "0")}|${month}`, time);
  }
  return times;
}

/**
 * Creative team from "label <strong>Name</strong>" lines, split on `<br>`. The
 * spettacolo block lists "direttore / regia / scene / costumi / luci" runs plus a
 * standalone "Maestro del coro {Name}" line; each line's plain-text prefix is the
 * label, the bold run the name. Cast lives in `<div class="profile">` cards as
 * "{Role}<br><b>{Singer}</b>". Lines/cards that yield no label or no name (the
 * "Musica" byline, ensemble lines, prose) are dropped.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();

  const spettacolo =
    html.match(/id="spettacolo"[\s\S]*?(?=<h2 id="cast"|<h2 id="informazioni"|$)/i)?.[0] ?? "";
  for (const { label, name } of labelStrongLines(spettacolo)) {
    const fn = mapFunction(label);
    if (!fn) continue;
    for (const person of splitNames(name)) {
      const key = `${fn}|${person}`;
      if (seenCreative.has(key)) continue;
      seenCreative.add(key);
      creative.push({ function: fn, name: person });
    }
  }

  for (const [, card] of html.matchAll(/<div class="profile[^"]*">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
    const text = (card ?? "").match(/<div class="text">([\s\S]*?)<\/div>/i)?.[1] ?? card ?? "";
    const singer = cleanText(text.match(/<b>([\s\S]*?)<\/b>/i)?.[1] ?? "");
    const role = cleanText(text.replace(/<b>[\s\S]*?<\/b>/gi, "").replace(/<br\s*\/?>/gi, " "));
    if (!singer || !role) continue;
    for (const person of splitNames(singer)) cast.push({ role, name: person });
  }

  return { creative_team: creative, cast };
}

/**
 * Parse "label <strong>Name</strong>" lines. A name may span several adjacent
 * `<strong>` runs ("scene <strong>Juan</strong> <strong>Giullermo Nova</strong>")
 * — merge consecutive bold runs into one name. Split lines on `<br>`; the value is
 * the merged bold run, the label the plain text before it. Lines with no bold run
 * (ensemble names, prose) yield no pair.
 */
function labelStrongLines(html: string): { label: string; name: string }[] {
  const normalized = html
    .replace(/<\/strong>(\s*)<strong>/gi, "$1")
    .replace(/<\/p>|<p[^>]*>/gi, "<br/>");
  const rows: { label: string; name: string }[] = [];
  for (const line of normalized.split(/<br\s*\/?>/i)) {
    const strong = line.match(/<strong>([\s\S]*?)<\/strong>/i);
    if (!strong) continue;
    const name = cleanText(strong[1] ?? "");
    const label = cleanText(line.slice(0, line.indexOf(strong[0]))).replace(/[:.]\s*$/, "");
    if (label && name) rows.push({ label, name });
  }
  return rows;
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A credit value may list several people; split on commas / " e ". Drop ensemble
 *  names (orchestra, coro, filarmonica) — not individual performers we model. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+e\s+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 2 && /[a-zà-ÿ]/.test(s) && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s),
    );
}

/** Italian opera seasons run autumn→summer; map a date to its "YYYY/YY" season. */
function seasonOf(date: IsoDate | null | undefined): string | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (!year || !month) return null;
  const start = month >= 8 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
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
