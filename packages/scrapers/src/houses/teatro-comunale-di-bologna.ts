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
 * Teatro Comunale di Bologna (`spielplan-html` strategy) — a fondazione lirica
 * playing across several venues while its historic theatre is under restoration:
 * the temporary Comunale Nouveau, the Teatro Manzoni, and assorted off-sites. The
 * site is a WordPress/uncode install whose events are a `portfolio` custom post
 * type at `/eventi/{slug}/`, grouped by an `eventi_cat`/`portfolio_category`
 * taxonomy (opera, danza, concerti, altri-eventi).
 *
 * The announced future lives in a server-rendered "event calendar" carousel on
 * the homepage: each `craqEventCalendarSlide` is ONE dated night carrying the day,
 * Italian month, a term (Opera / Danza / Concerti / Altri eventi), the
 * production's `/eventi/{slug}/` link, and a "{venue}, HH:MM" place line. That
 * `term="Opera"` IS the opera filter — danza, concerti and altri-eventi slides are
 * dropped — and grouping the opera nights by slug yields one production per work
 * with its full per-night performance list (date + time + venue). The carousel
 * lists month names without a year, so the year is inferred by rolling forward
 * from today (a month earlier than the current month belongs to next year).
 *
 * Each detail page is then fetched once for the production-level facts. The header
 * carries the title in an `<h2><span>` and the composer in the `<h4><span>`
 * directly under it (an "OPERA YYYY |" eyebrow precedes the title and is stripped);
 * a concert-form billing flags itself with "in forma di concerto" and is dropped
 * (sung, not staged). Composer is REQUIRED — the opera gate. Credits are
 * `label<br><strong>Name</strong>` lines inside `<h5>` blocks whose ITALIAN labels
 * (Direttore, Regia, Scene, Costumi, Luci, Maestro del Coro, …) map to canonical
 * functions in CREATIVE_LABELS; the cast is the `<p>ROLE<br><strong>Singer/Singer*
 * </strong></p>` rows under the "Personaggi e interpreti" heading (alternate-night
 * casts split on "/").
 *
 * The deep historical archive isn't walked here; pre-current history comes from
 * Wikidata (Q2306368, ~32 works incl. the 1867 Don Carlos premiere) in backfill.
 */

const BASE = "https://www.tcbo.it";
const HOME_URL = `${BASE}/`;
/** Teatro Comunale di Bologna on Wikidata — verified via wbsearchentities (it) →
 *  Q2306368 (P31 = opera house Q153562 + theatre Q24354, P17 = Italy Q38). 32 works
 *  link via P4647 (premiere here, e.g. Don Carlos 1867) / P272 (produced here); the
 *  sibling music-archive entity (Q117184545) bears none — Q2306368 is the
 *  production-bearing one. */
const WIKIDATA_QID = "Q2306368";

const ITALIAN_MONTHS: Record<string, number> = {
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12,
};

/**
 * Italian creative-function labels → canonical function keys, tested in order.
 * "Regia" is matched before the set/costume rules because the site combines it
 * ("regia e scene"); chorus-master precedes the generic conductor rule (the site
 * spells the conductor "Maestro concertatore e Direttore"). Unmapped labels
 * (assistants, revival supervisors) are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro|chorus master/i, "chorus-master"],
  [/direttore|maestro concertatore|direzione musicale|conductor/i, "conductor"],
  [/regia|staging|director/i, "director"],
  [/coreograf|movimenti coreografici|choreograph/i, "choreographer"],
  [/disegno luci|light designer|^luci\b|^luce\b|lights|lighting/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi|costumes/i, "costume-designer"],
  [/scenografia|^scene\b|^sets?\b|set design/i, "set-designer"],
  [/drammaturgia|dramaturgy/i, "dramaturgy"],
];

interface CalendarNight {
  date: IsoDate;
  time: string | null;
  venue: string | null;
}

export async function scrapeTeatroComunaleDiBologna(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const nightsBySlug = await discoverOperaNights(ctx);
    const today = new Date().toISOString().slice(0, 10);

    for (const [slug, nights] of nightsBySlug) {
      try {
        const prod = await buildProduction(slug, nights, ctx, since, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-comunale-di-bologna: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-comunale-di-bologna: calendar scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-comunale-di-bologna: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-comunale-di-bologna", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null).
 *  The carousel only carries announced future nights, so this mostly gates nothing
 *  on the live leg — it matters for the Wikidata backfill. */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - 45 * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/**
 * Read the homepage event-calendar carousel and group its opera nights by
 * production slug. Each `craqEventCalendarSlide` is one dated night; we keep only
 * `eventCalendarTerms` = "Opera" slides, parse the day + Italian month (year
 * inferred from today), the `/eventi/{slug}/` link, and the "{venue}, HH:MM"
 * place line.
 */
async function discoverOperaNights(ctx: FetchContext): Promise<Map<string, CalendarNight[]>> {
  const html = await fetchHtml(HOME_URL, ctx);
  const bySlug = new Map<string, CalendarNight[]>();

  for (const slide of html.split("craqEventCalendarSlide").slice(1)) {
    const term = field(slide, "eventCalendarTerms");
    if (!/^opera$/i.test(term ?? "")) continue;

    const slug = slide.match(/\/eventi\/([^/"]+)\//)?.[1];
    const dayRaw = field(slide, "eventCalendarDay");
    const monthRaw = field(slide, "eventCalendarMonth");
    if (!slug || !dayRaw || !monthRaw) continue;

    const date = isoFromDayMonth(dayRaw, monthRaw);
    if (!date) continue;

    const place = field(slide, "eventCalendarPlace");
    const { venue, time } = parsePlace(place);

    const list = bySlug.get(slug) ?? [];
    list.push({ date, time, venue });
    bySlug.set(slug, list);
  }

  return bySlug;
}

/** The carousel cells are `<div class="{name}">value</div>`. */
function field(slide: string, className: string): string | null {
  const m = slide.match(new RegExp(`${className}">([^<]*)</div>`));
  return m ? decodeEntities(m[1] ?? "").trim() || null : null;
}

/** Resolve a day + Italian month name to an ISO date. The carousel omits the year,
 *  so roll forward from today: a month before the current month is next year. */
function isoFromDayMonth(dayRaw: string, monthRaw: string): IsoDate | null {
  const day = Number.parseInt(dayRaw, 10);
  const month = ITALIAN_MONTHS[monthRaw.toLowerCase()];
  if (!day || !month) return null;
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth() + 1;
  const year = month >= curMonth ? curYear : curYear + 1;
  return isoFromParts(year, month, day);
}

/** Place line is "{venue}, HH:MM" (e.g. "Comunale Nouveau, 20:00"). */
function parsePlace(place: string | null): { venue: string | null; time: string | null } {
  if (!place) return { venue: null, time: null };
  const time = place.match(/(\d{1,2})[:.](\d{2})\s*$/);
  const hhmm = time ? `${time[1]?.padStart(2, "0")}:${time[2]}` : null;
  const venue = place.replace(/,?\s*\d{1,2}[:.]\d{2}\s*$/, "").trim();
  return { venue: venue || null, time: hhmm };
}

async function buildProduction(
  slug: string,
  nights: CalendarNight[],
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}/eventi/${slug}/`, ctx);
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ");

  // Concert-form operas are sung, not staged — drop them (the maggio/verona gate).
  if (/in forma di concerto/i.test(body)) return null;

  const composer = parseComposer(body);
  if (!composer) return null;

  const title = parseTitle(body);
  if (!title) return null;

  const performances = nights
    .filter((n) => !since || n.date >= since)
    .map(
      (n): RawPerformance => ({
        date: n.date,
        time: n.time,
        venue_room: n.venue,
        status: n.date < today ? "past" : "scheduled",
      }),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  if (performances.length === 0) return null;

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: `${BASE}/eventi/${slug}/`,
    image_url: html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1] ?? null,
    ...parseCredits(body),
    performances,
  };
}

/**
 * Title is the header `<h2><span>WORK</span></h2>`, after dropping the "OPERA
 * YYYY |" eyebrow some titles still embed (the carousel slug carries it too).
 */
function parseTitle(body: string): string | null {
  for (const m of body.matchAll(/<h2[^>]*>\s*<span>([\s\S]*?)<\/span>\s*<\/h2>/gi)) {
    const t = cleanText(m[1] ?? "").replace(/^opera\s*\d{4}\s*\|?\s*/i, "");
    if (t && !/^opera\s*\d{4}$/i.test(t)) return t;
  }
  return null;
}

/**
 * Composer = the `<h4><span>NAME</span></h4>` line directly under the title. The
 * header runs eyebrow → `<h2>` title → `<h4>` composer, so we take the first h4
 * span after the title heading that reads as a person name. Returns null when none
 * resolves → the billing is dropped (the opera gate).
 */
function parseComposer(body: string): string | null {
  const titleMatch = body.match(/<h2[^>]*>\s*<span>[\s\S]*?<\/span>\s*<\/h2>/i);
  const after = titleMatch ? body.slice((titleMatch.index ?? 0) + titleMatch[0].length) : body;
  for (const m of after.matchAll(/<h4[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/h4>/gi)) {
    const name = cleanText(m[1] ?? "");
    if (looksLikeComposer(name)) return name;
    if (name && !/forma di concerto|opera in|melodramma/i.test(name)) break;
  }
  return null;
}

/** One-or-more capitalized name tokens (allowing "/" double bills, " & ", " e "),
 *  rejecting eyebrows and form lines that read as a sentence. */
function looksLikeComposer(text: string): boolean {
  if (!text || text.length > 70) return false;
  const segments = text.split(/\s*[/&]\s*|\s+e\s+/).map((s) => s.trim());
  return (
    segments.length > 0 &&
    segments.every((seg) => /^[A-ZÀ-Ý][a-zà-ÿ.'’-]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ.'’-]+){0,3}$/.test(seg))
  );
}

/**
 * Both credit kinds share one line shape — `label<br><strong>Name</strong>` —
 * spread across `<h5>` blocks (Direttore, Regia, Maestro del Coro) and `<p>` rows
 * under the "Team creativo" (Scene, Costumi, Luci) and "Personaggi e interpreti"
 * (role → singer) headings. We parse every such line and let the label decide: a
 * label that maps to a canonical function is a creative credit; a short label that
 * doesn't is a sung role → cast (long emphasised prose lines and ensemble rows are
 * dropped). Alternate-night casts list several `<strong>` singers per role.
 */
function parseCredits(body: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const { label, names } of creditLines(body)) {
    const fn = mapFunction(label);
    if (fn) {
      for (const person of names) {
        const key = `${fn}|${person}`;
        if (seenCreative.has(key)) continue;
        seenCreative.add(key);
        creative.push({ function: fn, name: person });
      }
    } else if (looksLikeRole(label)) {
      for (const singer of names) {
        const key = `${label}|${singer}`;
        if (seenCast.has(key)) continue;
        seenCast.add(key);
        cast.push({ role: label, name: singer });
      }
    }
  }
  return { creative_team: creative, cast };
}

/** Every `label<br><strong>Name</strong>` line in an `<h5>` block or `<p>` row.
 *  The label is the plain text before the first `<strong>`; the names are all the
 *  `<strong>` runs (alternate-night casts and split values flattened). */
function creditLines(body: string): { label: string; names: string[] }[] {
  const rows: { label: string; names: string[] }[] = [];
  for (const [, block] of body.matchAll(/<(?:h5|p)[^>]*>([\s\S]*?)<\/(?:h5|p)>/gi)) {
    if (!block || !/<strong>/i.test(block)) continue;
    const label = cleanLabel(block.slice(0, block.indexOf("<strong")));
    if (!label) continue;
    const names: string[] = [];
    for (const [, raw] of block.matchAll(/<strong>([\s\S]*?)<\/strong>/gi))
      names.push(...splitNames(cleanText(raw ?? "")));
    if (names.length) rows.push({ label, names });
  }
  return rows;
}

/** Production-staff labels with no canonical credit function — assistants, revival
 *  supervisors. They aren't sung roles, so they're dropped rather than misfiled. */
const NON_ROLE_LABELS =
  /assistente|aiuto|collabora|sopratitoli|allest|durata|riprese|ripresa|librett|maestr|drammaturg|orchestra|^coro\b/i;

/** A role label is a short character name, not a synopsis fragment or staff label. */
function looksLikeRole(label: string): boolean {
  if (label.length > 40 || label.split(/\s+/).length > 6) return false;
  if (NON_ROLE_LABELS.test(label)) return false;
  return true;
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

/** A credit value may list several people; split on "/", commas and " e ", and
 *  strip the alternate-night markers ("*", "(16, 18, 20)"). Drop ensemble names. */
function splitNames(value: string): string[] {
  return value
    .replace(/\([^)]*\)/g, "")
    .split(/\s*\/\s*|\s*,\s*|\s+e\s+/)
    .map((s) => s.replace(/\*/g, "").trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s));
}

/** Italian opera seasons run autumn→summer; treat Aug+ as the new season start. */
function seasonOf(date: IsoDate | null | undefined): string | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (!year || !month) return null;
  const start = month >= 8 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Typographic / accented entities the shared `decodeEntities` map omits but that
 *  show up in Italian role and singer names. */
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
