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
import { isoFromParts } from "./_dates";

/**
 * Teatro Petruzzelli, Bari (`json-api` strategy — WordPress REST + SSR detail HTML).
 *
 * The house publishes its "Opera e Balletto" season as a WordPress `eventi`
 * custom post type. The unauthenticated REST API (`/wp-json/wp/v2/eventi`)
 * cheaply enumerates a season's billings by category, but its `content.rendered`
 * carries only the creative team and a prose synopsis — the per-night dates,
 * times and the structured composer/title sit in the SSR detail page. So we use
 * the API purely as an index (one call per season term → ids + links) and read
 * each production off its `/eventi/{slug}/` detail DOM.
 *
 * The opera+ballet strand lives under the `opera-e-balletto` category (id 16),
 * whose per-year child terms (`2014`…`2025`) hold the archive; the current
 * season is a sibling term `ob-{year}` (e.g. `ob-2026`). Both mix staged opera
 * with ballet, so opera is decided on the detail page by THREE signals together:
 *   - a composer — from the title's composer segment, the `<div
 *     class='autore_evento'>` byline, or the content's "musica di {X}" / leading
 *     "di {X}" line (REQUIRED — the opera gate);
 *   - a `direttore` (conductor) credit — every opera has one; ballets lead with
 *     `coreografia` + `musica` and carry no conductor;
 *   - no ballet marker ("Balletto in …", "scuola di ballo", "teatro danza").
 * That drops the ballets (Lago dei cigni, Schiaccianoci, …) and the dance galas
 * that share the strand while keeping sung opera, including dance-heavy operas
 * (a "corpo di ballo" alone is NOT a ballet marker — La traviata lists one).
 *
 * Performances come from the detail page's "Orari Spettacoli" block:
 * `<div class='date'>WEEKDAY DD MONTH YYYY - HH:MM | turno</div>` rows (Italian
 * weekday/month names, 24h time). The single venue is the Teatro Petruzzelli.
 * Credits are `<em>label</em> <strong>Name</strong>` rows (multi-name runs split
 * on `|`, a stray `<br>` sometimes nested inside the bold run); their Italian
 * labels map to canonical functions in CREATIVE_LABELS.
 *
 * The deep pre-2021 archive thins out on the detail pages (older billings drop
 * the structured composer/date markup); that history comes from Wikidata
 * (Q845510) in backfill mode.
 */

const BASE = "https://www.fondazionepetruzzelli.it";
const API = `${BASE}/wp-json/wp/v2`;
const VENUE = "Teatro Petruzzelli";
/** Teatro Petruzzelli on Wikidata — verified via wbsearchentities (it) →
 *  EntityData Q845510: P31 = opera house (Q153562), P17 = Italy (Q38); works link
 *  via P4647 (first performance here). The sibling "Archivio Musicale"
 *  (Q117184542) is an archive, not the production-bearing house. */
const WIKIDATA_QID = "Q845510";

/** The umbrella opera+ballet category whose per-year child terms hold the archive. */
const OPERA_BALLET_CATEGORY = 16;
/** Backfill walks year terms down to this floor (detail markup thins out below it). */
const EARLIEST_SEASON = 2021;
/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/**
 * Italian creative-function labels → canonical function keys, tested in order.
 * "Regia" is matched before the set/costume rules because the site combines it
 * ("regia, scene, costumi"); chorus-master precedes the generic conductor rule.
 * Unmapped labels (assistants, "regia ripresa da", "video", ensemble lines) are
 * dropped.
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

const MONTHS: Record<string, string> = {
  gennaio: "01",
  febbraio: "02",
  marzo: "03",
  aprile: "04",
  maggio: "05",
  giugno: "06",
  luglio: "07",
  agosto: "08",
  settembre: "09",
  ottobre: "10",
  novembre: "11",
  dicembre: "12",
};

interface EventIndexRow {
  id: number;
  slug?: string | null;
  link?: string | null;
}

export async function scrapeTeatroPetruzzelliBari(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);
    const categoryIds = await discoverSeasonCategories(ctx, window);

    const seen = new Set<string>();
    for (const categoryId of categoryIds) {
      let rows: EventIndexRow[];
      try {
        rows = await fetchJson<EventIndexRow[]>(
          `${API}/eventi?categories=${categoryId}&per_page=50&_fields=id,slug,link`,
          ctx,
        );
      } catch (err) {
        console.warn(`teatro-petruzzelli-bari: category ${categoryId} index failed:`, err);
        continue;
      }
      for (const row of rows) {
        const detailUrl = row.link ?? (row.slug ? `${BASE}/eventi/${row.slug}/` : null);
        if (!detailUrl || seen.has(detailUrl)) continue;
        seen.add(detailUrl);
        try {
          const prod = await buildProduction(detailUrl, ctx, since, today);
          if (prod) productions.push(prod);
        } catch (err) {
          console.warn(`teatro-petruzzelli-bari: ${detailUrl} failed:`, err);
        }
      }
    }
  } catch (err) {
    console.warn("teatro-petruzzelli-bari: season scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-petruzzelli-bari: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-petruzzelli-bari", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/**
 * The category ids to walk. Incremental reads only the current `ob-{year}` strand
 * plus the umbrella's latest year child (covers a season straddling the rollover);
 * backfill additionally walks the umbrella's earlier year children down to
 * `window.since` (or EARLIEST_SEASON), since the per-year terms each carry one
 * season's billings.
 */
async function discoverSeasonCategories(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<number[]> {
  const ids = new Set<number>();
  const year = new Date().getUTCFullYear();

  // The current season's sibling strand `ob-{year}` (and a one-year lookahead for
  // a season announced under next year's term before the rollover).
  for (const slug of [`ob-${year}`, `ob-${year + 1}`]) {
    const id = await categoryIdBySlug(slug, ctx);
    if (id) ids.add(id);
  }

  const yearChildren = await fetchYearChildren(ctx);
  const floor =
    window.mode === "backfill"
      ? (window.since ? Number.parseInt(window.since.slice(0, 4), 10) : 0) || 0
      : year - 1;
  for (const { id, year: childYear } of yearChildren) {
    if (childYear >= Math.max(floor, EARLIEST_SEASON)) ids.add(id);
  }

  return [...ids];
}

async function categoryIdBySlug(slug: string, ctx: FetchContext): Promise<number | null> {
  try {
    const rows = await fetchJson<{ id: number; count: number }[]>(
      `${API}/categories?slug=${slug}&_fields=id,count`,
      ctx,
    );
    const row = rows.find((r) => r.count > 0) ?? rows[0];
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** The umbrella category's per-year child terms (`2021`, `2022`, …) → {id, year}. */
async function fetchYearChildren(ctx: FetchContext): Promise<{ id: number; year: number }[]> {
  try {
    const rows = await fetchJson<{ id: number; slug: string; count: number }[]>(
      `${API}/categories?parent=${OPERA_BALLET_CATEGORY}&per_page=100&_fields=id,slug,count`,
      ctx,
    );
    return rows
      .filter((r) => r.count > 0 && /^\d{4}$/.test(r.slug))
      .map((r) => ({ id: r.id, year: Number.parseInt(r.slug, 10) }));
  } catch {
    return [];
  }
}

async function buildProduction(
  detailUrl: string,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  const html = await fetchHtml(detailUrl, ctx);

  // Ballet markers: the work-form line ("Balletto in …"), a dance school/company
  // as the performing body ("scuola di ballo"), or "teatro danza". A ballet still
  // names a composer (Čajkovskij scores one) and even a conductor, so these
  // markers — not the composer — are the discriminator. "corpo di ballo" is NOT a
  // marker: operas list one for their dance scenes (e.g. La traviata).
  if (/\bBalletto\s+in\b|scuola di ballo|teatro danza/i.test(html)) return null;

  const { title, titleComposer } = parseTitle(html);
  if (!title) return null;

  const content = sliceContent(html);
  const composer = parseComposer(html, content, titleComposer);
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(content);
  // Every staged opera here carries a conductor ("direttore"); the few dance
  // billings that slip the ballet-marker check lead with "coreografia" and name
  // none — so a missing conductor drops them.
  if (!creative_team.some((c) => c.function === "conductor")) return null;

  const performances = parsePerformances(html, since, today);
  if (performances.length === 0) return null;

  return {
    source_production_id: slugFromUrl(detailUrl),
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: detailUrl,
    image_url: parseImage(html),
    creative_team,
    cast,
    performances,
  };
}

/**
 * The visible billing title (`<div class='titleSection …'>…</div>`). Its segments
 * are joined by "|" (recent: WORK | COMPOSER | dates, or WORK | dates) or by an
 * en-dash (older: WORK – Composer). The leading segment is the work title; a
 * non-date segment that reads as a person name is the composer (the dates segment
 * — "18 – 26 aprile" — is recognised and discarded).
 */
function parseTitle(html: string): { title: string | null; titleComposer: string | null } {
  const raw = html.match(/class='titleSection[^>]*'>([\s\S]*?)<\/div>/i)?.[1];
  if (!raw) return { title: null, titleComposer: null };
  const segments = cleanText(raw)
    .split(/\s*\|\s*|\s+[–—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const title = segments[0] || null;
  const titleComposer =
    segments.slice(1).find((s) => !isDateRange(s) && looksLikeComposer(s)) ?? null;
  return { title, titleComposer };
}

const MONTH_RE = new RegExp(`\\b(${Object.keys(MONTHS).join("|")})\\b`, "i");
function isDateRange(text: string): boolean {
  return /\d/.test(text) && MONTH_RE.test(text);
}

/**
 * Composer priority: the title's composer segment (the most reliable, present on
 * the recent `WORK | Composer | dates` and the older `WORK – Composer` titles) →
 * the `<div class='autore_evento'>` byline (full name) → the content's opening
 * "musica di {X}" / leading "di {X}" byline. Returns null when none resolves →
 * the billing is dropped (opera gate).
 */
function parseComposer(html: string, content: string, titleComposer: string | null): string | null {
  if (titleComposer) return titleComposer;

  const autore = cleanText(html.match(/class='autore_evento'>([\s\S]*?)<\/div>/i)?.[1] ?? "");
  if (autore && looksLikeComposer(autore)) return autore;

  // The content's first credit paragraph opens with the composer byline: "musica
  // di {X}" or a bare "di {X}". A "di {X}" preceded by "libretto" is the
  // LIBRETTIST, never the composer, so it's excluded.
  const firstPara = cleanText(content.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
  const fromMusica = firstPara.match(/musica di\s+([^|.,;()]+)/i);
  if (fromMusica?.[1] && looksLikeComposer(cleanText(fromMusica[1])))
    return cleanText(fromMusica[1]);
  const fromDi = firstPara.match(/(?<!libretto\s)\bdi\s+([^|.,;()]+)/i);
  if (fromDi?.[1] && looksLikeComposer(cleanText(fromDi[1]))) return cleanText(fromDi[1]);

  return null;
}

/** One-or-more capitalized name tokens (allowing "/" double bills, " e " joins),
 *  rejecting prose fragments that read as a sentence. */
function looksLikeComposer(text: string): boolean {
  const segments = text.split(/\s*\/\s*|\s+e\s+/).map((s) => s.trim());
  return (
    segments.length > 0 &&
    segments.every((seg) =>
      /^[A-ZÀ-ÝŠŽČ][a-zà-ÿšžčćđ.'’-]+(?:\s+[A-ZÀ-ÝŠŽČ][a-zà-ÿšžčćđ.'’-]+){0,3}$/.test(seg),
    )
  );
}

/** The detail page's `<div class="content">…</div>` block (credits + byline + synopsis). */
function sliceContent(html: string): string {
  const i = html.indexOf('<div class="content">');
  if (i < 0) return "";
  return html.slice(i, html.indexOf("<div class='row'>", i) + 1 || html.length);
}

function parseImage(html: string): string | null {
  const m = html.match(/headerEvents[^>]*style='background-image:url\("([^"]+)"/i);
  return m?.[1] ?? null;
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}

/**
 * Performances from the "Orari Spettacoli" block: `<div class='date'>WEEKDAY DD
 * MONTH YYYY - HH:MM | turno</div>` rows (Italian month names, 24h time). Honors
 * `since`; status is "past" once the date is behind today.
 */
function parsePerformances(html: string, since: IsoDate | null, today: string): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const [, raw] of html.matchAll(/<div class='date'>([^<]+)<\/div>/gi)) {
    const text = decodeEntities(raw ?? "").replace(/ /g, " ");
    const m = text.match(/(\d{1,2})\s+([a-zà-ÿ]+)\s+(\d{4})(?:[^0-9]*(\d{1,2})[:.](\d{2}))?/i);
    if (!m) continue;
    const month = MONTHS[(m[2] ?? "").toLowerCase()];
    if (!month) continue;
    const date = isoFromParts(m[3] ?? "", month, m[1] ?? "");
    if (!date) continue;
    if (since && date < since) continue;
    const hhmm = m[4] && m[5] ? `${m[4].padStart(2, "0")}:${m[5]}` : null;
    const key = `${date}|${hhmm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time: hhmm,
      venue_room: VENUE,
      status: date < today ? "past" : "scheduled",
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/**
 * Creative team from `<em>label</em> <strong>Name</strong>` rows. The markup is
 * irregular: a stray `<br>` sometimes sits inside the bold run
 * ("<strong>Name<br /></strong>") and multi-person credits join names with "|"
 * across several `<strong>` runs ("costumi <strong>A</strong>|<strong>B</strong>").
 * We read each `<em>…</em>` label with the bold text that follows it up to the
 * next `<em>`. A single name is sometimes fractured across adjacent `<b>`/`<strong>`
 * runs ("<strong>MAŁGORZATA</strong> <b>S</b><strong>Ł</strong>…"), so we strip the
 * bold-tag boundaries and keep the run's plain text, splitting people only on the
 * real separators ("|", commas, " e "). No structured cast is published, so `cast`
 * is always empty.
 */
function parseCredits(content: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative: RawCredit[] = [];
  const seen = new Set<string>();

  const labels = [...content.matchAll(/<em>([\s\S]*?)<\/em>/gi)];
  for (let i = 0; i < labels.length; i++) {
    const label = cleanLabel(labels[i]?.[1] ?? "");
    const fn = mapFunction(label);
    if (!fn) continue;
    const start = (labels[i]?.index ?? 0) + (labels[i]?.[0].length ?? 0);
    // A credit's value runs to the next label, but never past the end of its own
    // paragraph — that keeps a trailing synopsis/ensemble `<p>` (after the last
    // label) out of the name list.
    const paraEnd = content.indexOf("</p>", start);
    const nextLabel = labels[i + 1]?.index ?? content.length;
    const end = Math.min(nextLabel, paraEnd < 0 ? content.length : paraEnd);
    // Drop the bold-tag boundaries so a name fractured across adjacent runs
    // reassembles, but keep the "|" separators (plain text between runs) so a
    // multi-person credit still splits; ensemble/credit-footer lines that trail
    // the last label are caught by splitNames' filter.
    const value = content.slice(start, end).replace(/<\/?(?:strong|b)>/gi, "");
    for (const person of splitNames(cleanText(value))) {
      const key = `${fn}|${person}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative.push({ function: fn, name: person });
    }
  }
  return { creative_team: creative, cast: [] };
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

/** A credit value may list several people; split on "|", commas, " e ". Drop
 *  ensemble names (orchestra, coro, corpo di ballo) — not individual performers. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*\|\s*|\s*,\s*|\s+e\s+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 2 &&
        !/orchestra|\bcoro\b|filarmonica|ensemble|corpo di ballo|fondazione/i.test(s),
    );
}

/** Italian opera seasons run within a calendar year here; the year carries the season. */
function seasonOf(date: IsoDate | null | undefined): string | null {
  return date ? date.slice(0, 4) : null;
}

/** Typographic / accented entities the shared `decodeEntities` map omits but that
 *  show up in Italian/Slavic composer and title names (Čajkovskij, l'elisir). */
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
