import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Teatro Lirico di Cagliari, Sardinia (`spielplan-html` strategy). A WordPress +
 * Elementor site whose programming lives in an `evento` custom post type tagged
 * by the `categoria-evento` taxonomy (Opera / Danza / Concerti / Rotte Sonore).
 * That taxonomy IS the opera filter — we read the term whose slug is `opera`
 * from the WP REST API (`/wp-json/wp/v2/categoria-evento?slug=opera`) and list
 * only the events carrying it (`?categoria-evento={id}`), so balletto, concerti
 * and the summer pop strand never enter the result.
 *
 * The REST API exposes the event list (slug/title/link/publish date) but not the
 * body — ACF fields aren't registered for REST and `content` is omitted — so each
 * opera's facts come from its server-rendered Elementor detail page:
 *   - composer from the "Musica di {X}" libretto line — REQUIRED (the opera gate);
 *   - performances from `.widget-date-item` cards, each a `.wd-day-name` Italian
 *     weekday abbreviation + `.wd-date-value` "DD/MM" + `.wd-time-value` "HH:MM".
 *     The cards carry NO year, and the page's "dal … al … YYYY" byline is an
 *     unreliable placeholder on some events (Turandot's reads Dec 2025 while its
 *     dates are the following June), so the year is INFERRED at the production
 *     level: the cards' printed weekdays vote for the year whose calendar matches
 *     most of them, which survives the occasional mistyped weekday on one card;
 *   - creative team from the "Team creativo" text block as `label Name` lines
 *     (split on `<br>`), whose Italian labels map to canonical functions below;
 *   - cast from the "Cast" text block as `role <strong>Singer</strong>` lines,
 *     where a trailing "(11-13)/Other Singer" alternation lists the cover.
 *
 * The site holds only the current season (~30 events, no archive), so the live
 * leg is the whole announced programme and `window` just gates which performances
 * survive; deep history would come from Wikidata (Q1453465) in backfill mode,
 * though that entity currently carries no P4647/P272 works.
 */

const BASE = "https://www.liricocagliari.it";
const REST = `${BASE}/wp-json/wp/v2`;

/** Teatro Lirico di Cagliari on Wikidata — verified via wbsearchentities (it) →
 *  EntityData Q1453465: P31 = opera house (Q153562), P17 = Italy (Q38), itwiki
 *  sitelink present. The sibling entity Q119133084 (P31 = Q20819922) is not the
 *  building. Neither carries P4647/P272 works yet, so backfill returns nothing —
 *  the wiring is kept for when Wikidata gains Cagliari premieres/productions. */
const WIKIDATA_QID = "Q1453465";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/**
 * Italian creative-function labels → canonical function keys, tested in order.
 * "Regia" is matched before the set/costume rules (the site combines it, e.g.
 * "regia e scene"); chorus-master precedes the generic conductor rule. Unmapped
 * labels are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro/i, "chorus-master"],
  [/direttore|direzione musicale|maestro concertatore/i, "conductor"],
  [/regia/i, "director"],
  [/coreograf/i, "choreographer"],
  [/disegno luci|^luci\b|^luce\b/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi/i, "costume-designer"],
  [/scenografia|^scene\b/i, "set-designer"],
  [/drammaturgia/i, "dramaturgy"],
];

/** Italian weekday abbreviations as printed in `.wd-day-name` → JS getUTCDay(). */
const WEEKDAYS: Record<string, number> = {
  dom: 0,
  lun: 1,
  mar: 2,
  mer: 3,
  gio: 4,
  ven: 5,
  sab: 6,
};

interface EventListItem {
  slug?: string | null;
  link?: string | null;
  date?: string | null;
  title?: { rendered?: string | null } | null;
}

interface TaxonomyTerm {
  id: number;
  slug?: string | null;
}

export async function scrapeTeatroLiricoDiCagliari(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);
    const events = await listOperaEvents(ctx);

    for (const event of events) {
      const url = event.link ?? (event.slug ? `${BASE}/evento/${event.slug}/` : null);
      if (!url) continue;
      try {
        const prod = await buildProduction(event, url, ctx, since, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-lirico-di-cagliari: ${event.slug ?? url} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-lirico-di-cagliari: season scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-lirico-di-cagliari: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-lirico-di-cagliari", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** The staged-opera events: resolve the `opera` taxonomy term id, then list the
 *  events carrying it. Yields nothing if the term can't be resolved. */
async function listOperaEvents(ctx: FetchContext): Promise<EventListItem[]> {
  const terms = await fetchJson<TaxonomyTerm[]>(
    `${REST}/categoria-evento?slug=opera&per_page=1`,
    ctx,
  );
  const operaTermId = terms[0]?.id;
  if (!operaTermId) return [];

  return fetchJson<EventListItem[]>(
    `${REST}/evento?categoria-evento=${operaTermId}&per_page=100`,
    ctx,
  );
}

async function buildProduction(
  event: EventListItem,
  url: string,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  const html = await fetchHtml(url, ctx);

  const title = cleanText(event.title?.rendered ?? "");
  if (!title) return null;

  const composer = parseComposer(html);
  if (!composer) return null;

  const performances = parsePerformances(html, event.date ?? null, since, today);
  if (performances.length === 0) return null;

  return {
    source_production_id: event.slug ?? slugFromUrl(url),
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: url,
    image_url: parseImage(html),
    ...parseCredits(html),
    performances,
  };
}

/** Composer = the "Musica di {X}" libretto line (the opera gate). Returns null
 *  when no such byline is present, dropping the billing. */
function parseComposer(html: string): string | null {
  const text = textBody(html);
  const m = text.match(/musica di\s+([^\n,.]+)/i);
  if (!m?.[1]) return null;
  const name = cleanText(m[1]);
  return looksLikeComposer(name) ? name : null;
}

/** One-or-more capitalized name tokens (allowing "/" double bills, " e " joins),
 *  rejecting form words and sentence fragments. */
function looksLikeComposer(text: string): boolean {
  const segments = text.split(/\s*\/\s*|\s+e\s+/).map((s) => s.trim());
  return (
    segments.length > 0 &&
    segments.every((seg) => /^[A-ZÀ-Ý][a-zà-ÿ.'’-]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ.'’-]+){0,3}$/.test(seg))
  );
}

/**
 * Performances from `.widget-date-item` cards. Each card carries a `.wd-day-name`
 * Italian weekday, a `.wd-date-value` "DD/MM" and a `.wd-time-value` "HH:MM"; the
 * year is absent. It's inferred at the PRODUCTION level: each card's
 * (weekday, day, month) triple votes for the year whose calendar matches, and the
 * single best-scoring year (nearest the event's publish year on a tie) is applied
 * to every card. Voting across the whole run survives the occasional mistyped
 * weekday on an individual card (the site has them) that a per-card lookup would
 * scatter into the wrong year.
 */
function parsePerformances(
  html: string,
  publishedAt: string | null,
  since: IsoDate | null,
  today: string,
): RawPerformance[] {
  const refYear = publishedAt
    ? Number.parseInt(publishedAt.slice(0, 4), 10)
    : new Date().getUTCFullYear();

  const cards: { day: number; month: number; weekday: string; time: string | null }[] = [];
  for (const [, card] of html.matchAll(/widget-date-item">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
    if (!card) continue;
    const weekday = card.match(/wd-day-name">\s*([^<]+?)\s*</i)?.[1]?.toLowerCase();
    const dm = card.match(/wd-date-value">\s*(\d{1,2})\/(\d{1,2})\s*</i);
    if (!weekday || !dm) continue;
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const time = card.match(/wd-time-value">\s*(\d{1,2}:\d{2})/i)?.[1]?.padStart(5, "0") ?? null;
    cards.push({ day, month, weekday, time });
  }
  if (cards.length === 0) return [];

  const year = inferYear(cards, refYear);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const { day, month, weekday, time } of cards) {
    void weekday;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) continue;
    const date = d.toISOString().slice(0, 10);
    if (since && date < since) continue;
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date: date as IsoDate,
      time,
      venue_room: "Teatro Lirico di Cagliari",
      status: date < today ? "past" : "scheduled",
    });
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/** Pick the year whose calendar matches the most cards' printed weekdays; ties
 *  break toward the year nearest the event's publish year. */
function inferYear(
  cards: { day: number; month: number; weekday: string }[],
  refYear: number,
): number {
  let bestYear = refYear;
  let bestScore = -1;
  for (let year = refYear - 1; year <= refYear + 2; year++) {
    let score = 0;
    for (const { day, month, weekday } of cards) {
      const target = WEEKDAYS[weekday];
      const d = new Date(Date.UTC(year, month - 1, day));
      if (d.getUTCMonth() === month - 1 && d.getUTCDay() === target) score++;
    }
    if (
      score > bestScore ||
      (score === bestScore && Math.abs(year - refYear) < Math.abs(bestYear - refYear))
    ) {
      bestScore = score;
      bestYear = year;
    }
  }
  return bestYear;
}

/**
 * Creative team and cast live in two distinct text blocks. The "Team creativo"
 * block lists `label Name` lines (the name is NOT bold), so each line's leading
 * Italian function word identifies the credit. The "Cast" block lists
 * `role <strong>Singer</strong>` lines, where the role is the plain text before
 * the bold run and a trailing "(dates)/Other Singer" names the cover.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  return {
    creative_team: parseCreativeTeam(blockAfterHeading(html, "Team creativo")),
    cast: parseCast(blockAfterHeading(html, "Cast")),
  };
}

/** The first text-editor `<p>` following an Elementor heading whose text matches. */
function blockAfterHeading(html: string, heading: string): string {
  const re = new RegExp(`${heading}\\b[\\s\\S]*?<p>([\\s\\S]*?)</p>`, "i");
  return html.match(re)?.[1] ?? "";
}

function parseCreativeTeam(block: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const line of block.split(/<br\s*\/?>/i)) {
    const text = cleanText(line);
    if (!text) continue;
    const fn = mapFunction(text);
    if (!fn) continue;
    const value = text.replace(/^[^A-ZÀ-Ý]*/, "").replace(matchedLabel(text) ?? "", "");
    for (const person of splitNames(value)) {
      const key = `${fn}|${person}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ function: fn, name: person });
    }
  }
  return out;
}

function parseCast(block: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const line of block.split(/<br\s*\/?>/i)) {
    const strong = line.match(/<strong>([\s\S]*?)<\/strong>/i);
    if (!strong) continue;
    const role = cleanLabel(line.slice(0, line.indexOf(strong[0])));
    if (!role || !looksLikeRole(role)) continue;
    // The bold run is the primary singer; a trailing "/Other" names the cover.
    const after = line.slice(line.indexOf(strong[0]) + strong[0].length);
    const cover = after.match(/\/\s*([A-ZÀ-Ý][^,(<]+)/)?.[1];
    for (const singer of [cleanText(strong[1] ?? ""), cover ? cleanText(cover) : ""]) {
      if (!singer) continue;
      const key = `${role}|${singer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ role, name: singer });
    }
  }
  return out;
}

/** The creative-team label is a leading Italian function phrase; strip it off the
 *  line to leave the name. Returns the matched phrase so the caller can remove it. */
function matchedLabel(text: string): string | null {
  return (
    text.match(
      /^(maestro del coro|direttore|direzione musicale|maestro concertatore|regia|coreografie?|disegno luci|luci|luce|scene e costumi|costumi|scenografia|scene|drammaturgia)\b/i,
    )?.[0] ?? null
  );
}

/** A role label is a short character name, not a staff term or sentence fragment. */
function looksLikeRole(label: string): boolean {
  if (label.length > 40 || label.split(/\s+/).length > 6) return false;
  if (mapFunction(label)) return false;
  if (/orchestra|\bcoro\b|allestimento|durata/i.test(label)) return false;
  return true;
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A credit value may list several people; split on commas / " e ". Drop ensemble
 *  names — they aren't individual performers we model. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+e\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s));
}

/** Plain-text body of the page with tags stripped, for the "Musica di" lookup. */
function textBody(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|br|h\d)>/gi, "\n");
  return decodeEntities(stripped.replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ");
}

function parseImage(html: string): string | null {
  return html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1] ?? null;
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}

function cleanLabel(html: string): string {
  return cleanText(html)
    .replace(/[:.]\s*$/, "")
    .trim();
}

function cleanText(html: string): string {
  return decodeEntities(stripHtml(html)).replace(/\s+/g, " ").trim();
}

/** Italian opera seasons straddle the calendar year; use the start year per the
 *  Aug–Jul convention so a December and the following April share one season. */
function seasonOf(date: IsoDate | null | undefined): string | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (!year || !month) return null;
  const start = month >= 8 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}
