import type { IsoDate } from "@opera-directory/schema";
import PQueue from "p-queue";
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
 * Teatro Lirico Giuseppe Verdi, Trieste (`spielplan-html` strategy). The
 * fondazione lirica plays opera, balletto and a symphonic season, and keeps a
 * strong operetta tradition (the historic Trieste operetta festival) — we keep
 * opera AND operetta and drop balletto / concerto / recital / danza.
 *
 * The site is WordPress (no season index page; the JSON-LD is Yoast boilerplate
 * with no Event/composer/date). Every billing is a `spettacoli` custom post type,
 * so detail URLs are enumerated from the open `wp-json/wp/v2/spettacoli` REST
 * endpoint (paginated, newest first) — keeping only the Italian `/it/spettacoli/`
 * links (the endpoint returns each show twice, it + en). Incremental reads the
 * first page or two; backfill walks every page back to `window.since`.
 *
 * The structured facts live in the SSR detail-page DOM, not the REST payload
 * (`acf`/`meta` aren't exposed):
 *   - title in `<h1 class="spettacolo-header-title">`;
 *   - composer from the "La produzione" / "Informazioni" prose as `Musica di {X}`
 *     (or the older `di {X}` byline) — REQUIRED (the opera gate). Concerts carry no
 *     such line and fail the gate; ballets carry it but are dropped by an explicit
 *     genre check (a `Balletto` / `Danza` paragraph, or a STAGIONE SINFONICA
 *     concert season);
 *   - performance dates from the header `<strong>` run, an Italian day-list that
 *     spans months and shares one trailing year ("27, 28 febbraio, 1, 6, 7, 8
 *     marzo 2026"); times are not published in the HTML, so they're null;
 *   - creative team + cast as `spettacolo-ruolo` (label) / `spettacolo-artista`
 *     (name) / `spettacolo-dida` (per-night hints, dropped) rows in two sections —
 *     "La produzione" (creative) and "Personaggi e interpreti" (cast). Italian
 *     labels map to canonical functions in CREATIVE_LABELS; unmapped staff drop.
 *
 * Deep past comes from Wikidata (Q2294135, ~31 works) in backfill mode.
 */

const BASE = "https://www.teatroverdi-trieste.com";
const REST_SPETTACOLI = `${BASE}/wp-json/wp/v2/spettacoli`;
const VENUE = "Teatro Verdi";
/** Teatro Lirico Giuseppe Verdi, Trieste — verified via wbsearchentities (it/en):
 *  Q2294135, P31 = opera house (Q153562), P17 = Italy (Q38); 31 works link via
 *  P4647 (premiere here) / P272 (produced here). The sibling theatre *company*
 *  (Q113070645, P31 = Q11812394) carries 0 — Q2294135 is the production-bearing one. */
const WIKIDATA_QID = "Q2294135";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;
/** REST page size + a hard page ceiling so a backfill can't spin forever. */
const PER_PAGE = 100;
const MAX_PAGES = 8;
/**
 * The host rate-limits bursts of detail fetches (it 429s an un-paced sequential
 * loop after a handful of requests). A `p-queue` capped at one request per ~1.1s
 * clears it — verified a 10-in-a-row sweep at this spacing returns all 200s — and
 * a 429-aware retry with backoff absorbs the occasional limiter hiccup so a
 * backfill (≈100s of pages) doesn't silently drop archive shows. No proxy for
 * this host. */
const DETAIL_INTERVAL_MS = 1100;
const FETCH_RETRIES = 4;
const RETRY_BACKOFF_MS = 5000;

/** Italian month names → 1-based month number, for the header day-list date string. */
const MONTHS: Record<string, number> = {
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

/** A standalone genre paragraph that marks a non-opera billing we drop. */
const NON_OPERA_GENRE = /^(balletto|danza|recital|concerto)\b/i;

/**
 * Italian creative-function labels → canonical function keys, tested in order.
 * "Regia" precedes the set/costume rules because the house combines it ("regia e
 * scene"); chorus-master precedes the generic conductor rule. "Scene e costumi"
 * folds to set-designer (the combined label). Unmapped staff (video, assistenti,
 * sopratitoli) are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro|chorus master/i, "chorus-master"],
  [/maestro concertatore|direttore|direzione|conductor/i, "conductor"],
  [/regia|staging|director/i, "director"],
  [/coreograf|movimenti scenici|choreograph/i, "choreographer"],
  [/disegno luci|^luci\b|^luce\b|lights|lighting/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi|costumes/i, "costume-designer"],
  [/scenografia|^scene\b|^sets?\b|set design/i, "set-designer"],
  [/drammaturgia|dramaturgy/i, "dramaturgy"],
];

/** Staff labels with no canonical function — they aren't sung roles either, so
 *  they're dropped rather than misfiled as cast. */
const NON_ROLE_LABELS =
  /video|maker|assistente|aiuto|maestr|collabora|sopratitoli|allest|riprese|movimenti|coproduzione|creazione|realizz|edizion|orchestrazione|riduzione/i;

export async function scrapeTeatroVerdiTrieste(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const detailUrls = await discoverDetailUrls(ctx, window);

    const today = new Date().toISOString().slice(0, 10);
    // One request per DETAIL_INTERVAL_MS — the host 429s an un-paced burst.
    const queue = new PQueue({ concurrency: 1, intervalCap: 1, interval: DETAIL_INTERVAL_MS });
    await Promise.all(
      detailUrls.map((detailUrl) =>
        queue.add(async () => {
          try {
            const prod = await buildProduction(detailUrl, ctx, since, today);
            if (prod) productions.push(prod);
          } catch (err) {
            console.warn(`teatro-verdi-trieste: ${detailUrl} failed:`, err);
          }
        }),
      ),
    );
  } catch (err) {
    console.warn("teatro-verdi-trieste: spettacoli scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-verdi-trieste: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-verdi-trieste", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

interface SpettacoloRest {
  link: string;
}

/**
 * Detail URLs from the `spettacoli` REST endpoint (newest first). The endpoint
 * returns every show twice — once per language — so we keep only the Italian
 * `/it/spettacoli/` links. Incremental reads a shallow first page; backfill walks
 * further (the post `date` is the publish date, not the run date, so the deep
 * floor is enforced per-production by `window.since`, not by stopping pagination).
 */
async function discoverDetailUrls(ctx: FetchContext, window: ScrapeWindow): Promise<string[]> {
  const maxPages = window.mode === "backfill" ? MAX_PAGES : 2;
  const urls = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    let rows: SpettacoloRest[];
    try {
      rows = await fetchJson<SpettacoloRest[]>(
        `${REST_SPETTACOLI}?per_page=${PER_PAGE}&page=${page}&_fields=link`,
        ctx,
      );
    } catch (err) {
      // The endpoint 400s past the last page; stop quietly.
      if (page > 1) break;
      throw err;
    }
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.link?.includes("/it/spettacoli/")) urls.add(row.link);
    }
    if (rows.length < PER_PAGE) break;
  }
  return [...urls];
}

/**
 * `fetchHtml` with a 429-aware retry: even with the queue's pacing the host's
 * limiter occasionally trips, so a 429 backs off and retries a few times rather
 * than dropping the show. Non-429 errors throw on the first try — only the
 * rate-limit signal is worth waiting on.
 */
async function fetchHtmlWithRetry(url: string, ctx: FetchContext): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS);
    try {
      return await fetchHtml(url, ctx);
    } catch (err) {
      lastErr = err;
      if (!/→ 429$/.test(String(err))) throw err;
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildProduction(
  detailUrl: string,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  const html = await fetchHtmlWithRetry(detailUrl, ctx);

  const info = infoParagraphs(html);
  if (isNonOpera(info)) return null;

  const composer = parseComposer(info);
  if (!composer) return null;

  const title = cleanText(
    html.match(/<h1 class="spettacolo-header-title">([\s\S]*?)<\/h1>/)?.[1] ?? "",
  );
  if (!title) return null;

  const infoText = info.join(" ");
  const performances = parsePerformances(html, infoText, since, today);
  if (performances.length === 0) return null;

  return {
    source_production_id: slugFromUrl(detailUrl),
    work_title: title,
    composer_name: composer,
    premiere_season: parseSeason(infoText),
    detail_url: detailUrl,
    image_url: parseImage(html),
    ...parseCredits(html),
    performances,
  };
}

/** Concert and ballet billings: a STAGIONE SINFONICA concert season carries no
 *  composer line (failing the opera gate anyway), and a ballet carries a standalone
 *  `Balletto` / `Danza` / `Recital` / `Concerto` genre paragraph. */
function isNonOpera(info: string[]): boolean {
  return info.some((p) => /stagione sinfonica/i.test(p) || NON_OPERA_GENRE.test(p));
}

/**
 * Composer, tested per paragraph in falling order of reliability:
 *   1. `Musica di {X}` — the structured composer byline (a pasticcio may list two,
 *      "Musica di Mozart e di Rossini", kept verbatim);
 *   2. a standalone `di {X}` paragraph — the older byline form (il-trovatore's
 *      `<p>di Giuseppe Verdi</p>`);
 *   3. `da {work} di {X}` — the source-work composer, for one-act reductions whose
 *      own byline credits the adapter ("Riduzione … di {adapter} (da La Traviata di
 *      Verdi)") rather than the composer.
 * Tier 3 only fires when 1 and 2 found nothing, so a libretto's source-play author
 * never wins over a real composer byline. Null → the billing is dropped (opera gate).
 */
function parseComposer(info: string[]): string | null {
  for (const para of info) {
    const m = para.match(/^\s*musich?[ea] di\s+(.+)$/i);
    if (m?.[1]) {
      const name = cleanComposer(m[1]);
      if (name) return name;
    }
  }
  for (const para of info) {
    const m = para.match(/^\s*di\s+([A-ZÀ-Ý].+)$/);
    if (m?.[1]) {
      const name = cleanComposer(m[1]);
      if (name) return name;
    }
  }
  for (const para of info) {
    const m = para.match(/\bda\s+.+?\s+di\s+([A-ZÀ-Ý].+)$/);
    if (m?.[1]) {
      const name = cleanComposer(m[1]);
      if (name) return name;
    }
  }
  return null;
}

/** Trim a composer byline to the name(s): cut a trailing clause (a librettist /
 *  source note opening with a comma, dash, or "libretto/dramma/tratto"), drop
 *  enclosing parens, and cap length so a runaway sentence can't pose as a name. */
function cleanComposer(raw: string): string | null {
  const name = cleanText(raw)
    .replace(/\s*[,–—-]\s.*$/, "")
    .replace(/\s+(?:libretto|dramma|tratto|su\b|orchestr).*$/i, "")
    .replace(/[()]/g, "")
    .trim();
  if (!name || name.length > 70) return null;
  return name;
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}

function parseImage(html: string): string | null {
  return html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1] ?? null;
}

/** Season from the "STAGIONE LIRICA … 2025-26" line → "2025/26". */
function parseSeason(info: string): string | null {
  const m = info.match(/stagione[^0-9]*(\d{4})[-/](\d{2,4})/i);
  if (!m) return null;
  return `${m[1]}/${m[2]?.slice(-2)}`;
}

/**
 * Performance dates from the header `<strong>` run — an Italian day-list that may
 * span months under one trailing year ("27, 28 febbraio, 1, 6, 7, 8 marzo 2026").
 * Times aren't published in the HTML, so they're null. Falls back to single
 * dd <month> yyyy lines in the Informazioni prose for the "Dal … al …" range form
 * whose header gives no enumerable list.
 */
function parsePerformances(
  html: string,
  info: string,
  since: IsoDate | null,
  today: string,
): RawPerformance[] {
  const header = cleanText(
    html.match(/spettacolo-header-small-title"><strong>([\s\S]*?)<\/strong>/)?.[1] ?? "",
  );
  let dates = parseDayList(header);
  if (dates.length === 0) dates = parseLooseDates(`${header} ${info}`);

  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const date of dates) {
    if (since && date < since) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({
      date: date as IsoDate,
      time: null,
      venue_room: VENUE,
      status: date < today ? "past" : "scheduled",
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/**
 * Parse a day-list like "27, 28 febbraio, 1, 6, 7, 8 marzo 2026". Days accumulate
 * until a month name closes the run, binding every queued day to that month; the
 * single trailing year applies to all. Months earlier than the first-seen month
 * roll into the next year (a Dec→Jan season crossing).
 */
function parseDayList(text: string): string[] {
  const year = text.match(/\b(20\d{2})\b/)?.[1];
  if (!year) return [];
  const baseYear = Number.parseInt(year, 10);
  const tokens = text.toLowerCase().match(/\d{1,2}|[a-zà-ÿ]+/g) ?? [];

  const out: string[] = [];
  let pendingDays: number[] = [];
  let firstMonth: number | null = null;
  for (const tok of tokens) {
    if (/^\d{1,2}$/.test(tok)) {
      const d = Number.parseInt(tok, 10);
      if (d >= 1 && d <= 31) pendingDays.push(d);
    } else if (tok in MONTHS) {
      const month = MONTHS[tok];
      if (month === undefined) continue;
      if (firstMonth === null) firstMonth = month;
      const yr = month < firstMonth ? baseYear + 1 : baseYear;
      for (const d of pendingDays) {
        const iso = isoFromParts(yr, month, d);
        if (iso) out.push(iso);
      }
      pendingDays = [];
    }
  }
  return out;
}

/** Fallback: standalone "dd <month> yyyy" dates anywhere in the text (range form). */
function parseLooseDates(text: string): string[] {
  const out: string[] = [];
  const re = /\b(\d{1,2})\s+([a-zà-ÿ]+)\s+(20\d{2})\b/gi;
  for (const [, d, mon, y] of text.matchAll(re)) {
    const month = MONTHS[(mon ?? "").toLowerCase()];
    if (!month || !d || !y) continue;
    const iso = isoFromParts(Number.parseInt(y, 10), month, Number.parseInt(d, 10));
    if (iso) out.push(iso);
  }
  return out;
}

/**
 * Credits live as `spettacolo-ruolo` (label) + `spettacolo-artista` (name) rows in
 * two sections: "La produzione" (creative team) and "Personaggi e interpreti"
 * (cast). The label decides: a row whose Italian label maps to a creative function
 * is a creative credit; a non-mapped, non-staff label is a sung role → cast. Rows
 * with an empty label (coproduction / creation notes) yield no credit.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  const blocks = [sectionHtml(html, "La produzione"), sectionHtml(html, "Personaggi e interpreti")];
  for (const block of blocks) {
    for (const { label, name } of artistBlocks(block)) {
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

/** `<div class="artista-block">` rows of ruolo (label) + artista (name) spans. */
function artistBlocks(html: string): { label: string; name: string }[] {
  const rows: { label: string; name: string }[] = [];
  for (const [, ruolo, artista] of html.matchAll(
    /spettacolo-ruolo">([\s\S]*?)<\/span>\s*<span class="spettacolo-artista">([\s\S]*?)<\/span>/gi,
  )) {
    const label = cleanText(ruolo ?? "").replace(/[:.]\s*$/, "");
    const name = cleanText(artista ?? "");
    if (label && name) rows.push({ label, name });
  }
  return rows;
}

/** A role label is a short character name, not a staff label or a prose fragment. */
function looksLikeRole(label: string): boolean {
  if (label.length > 40 || label.split(/\s+/).length > 6) return false;
  return !NON_ROLE_LABELS.test(label);
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

/** The inner HTML of a `spettacolo-block` section by its `<h2>` heading. */
function sectionHtml(html: string, heading: string): string {
  const re = new RegExp(`<h2>${heading}</h2>([\\s\\S]*?)</section>`, "i");
  return html.match(re)?.[1] ?? "";
}

/** The Informazioni section's paragraphs as plain text. */
function infoParagraphs(html: string): string[] {
  const block = sectionHtml(html, "Informazioni");
  return [...block.matchAll(/<p>([\s\S]*?)<\/p>/gi)].map(([, p]) => cleanText(p ?? ""));
}

/** Typographic / accented entities the shared `decodeEntities` map omits but that
 *  show up in Italian and Central-European names (Čajkovskij, Dvořák). */
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
