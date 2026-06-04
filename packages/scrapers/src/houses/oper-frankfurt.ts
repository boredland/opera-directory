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
import { GERMAN_CREDIT_LABELS, normalizeGermanCredit } from "./_german-credits";

/**
 * Oper Frankfurt (`spielplan-html` strategy) — the reference adapter.
 *
 * Discovery, in three moves (see the README "How we discover past productions"):
 *   1. SLUGS — the live Spielplan (`/de/spielplan/`) shows a rolling ~40-card
 *      window; `?datum=YYYY-MM-DD` pages it. We union the production slugs across
 *      the season span. Slug = the production's stable identity at this house.
 *   2. PER-PRODUCTION — each detail page (`/de/spielplan/{slug}/`) carries the
 *      work title, composer, the creative team (a clean <dl> under "Besetzung"),
 *      the sung cast (looser <p> blocks), and a `calendar-list` listing EVERY
 *      performance date of the run, grouped by month. One fetch = one production.
 *   3. PER-NIGHT ATTRS — the spielplan cards carry time / room / sold-out status;
 *      we join those onto the detail-page dates by (slug, date).
 *
 * The `ScrapeWindow` only floors which performances we emit (`window.since`):
 * incremental keeps future + recent past, backfill keeps everything the site
 * exposes. NOTE: oper-frankfurt.de publishes only the current rolling repertoire
 * — there is no deep archive (the once-documented `/spielplan/archiv/` is gone).
 * Pre-current-season backfill for this house must come from the `wikidata-sparql`
 * strategy, not from here.
 */

const BASE = "https://oper-frankfurt.de";
const SPIELPLAN_URL = `${BASE}/de/spielplan/`;
/** Oper Frankfurt (the company) on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q568931";

export async function scrapeOperFrankfurt(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const { slugs, cards } = await discoverRepertoire(ctx);

  const productions: RawProduction[] = [];
  for (const slug of slugs) {
    try {
      const prod = await scrapeProduction(ctx, slug, cards, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`oper-frankfurt: production "${slug}" failed:`, err);
    }
  }

  // The live site has no deep archive (§ module doc); pull historical premieres
  // from Wikidata to backfill the long tail. Skipped on nightly incremental runs.
  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("oper-frankfurt: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "oper-frankfurt", productions };
}

// ── Discovery: slugs + per-night card attributes ────────────────────────────

interface CardAttrs {
  time: string | null;
  venueRoom: string | null;
  status: RawPerformance["status"];
}

interface Repertoire {
  slugs: string[];
  /** keyed by `${slug}|${isoDate}` — time / room / status as printed on the card */
  cards: Map<string, CardAttrs>;
}

async function discoverRepertoire(ctx: FetchContext): Promise<Repertoire> {
  const slugs = new Set<string>();
  const cards = new Map<string, CardAttrs>();

  const firstHtml = await fetchHtml(SPIELPLAN_URL, ctx);
  collectPage(firstHtml, SPIELPLAN_URL, slugs, cards);

  // The first page only spans the next few weeks; step `?datum=` across the rest
  // of the announced season (one probe per remaining month) to surface every slug.
  const datesAvailable = extractDatesAvailable(firstHtml);
  for (const monthStart of monthStarts(datesAvailable).slice(1)) {
    const url = `${SPIELPLAN_URL}?datum=${monthStart}`;
    try {
      collectPage(await fetchHtml(url, ctx), url, slugs, cards);
    } catch (err) {
      console.warn(`oper-frankfurt: spielplan page ${monthStart} failed:`, err);
    }
  }

  return { slugs: [...slugs], cards };
}

function collectPage(
  html: string,
  pageUrl: string,
  slugs: Set<string>,
  cards: Map<string, CardAttrs>,
): void {
  const datesAvailable = extractDatesAvailable(html);
  // Cards carry day-of-month only; `dates_available` is the spine that turns the
  // day into a full ISO date. Align the cursor to the page's start date so the
  // walk stays correct on `?datum=` pages that begin mid-season.
  const datumParam = new URL(pageUrl, BASE).searchParams.get("datum");
  let cursor = datumParam
    ? Math.max(
        0,
        datesAvailable.findIndex((d) => d >= datumParam),
      )
    : 0;
  let prevDay: number | null = null;

  for (const block of extractRepertoireBlocks(html)) {
    const href = matchAttr(block, /<a\b[^>]*\bhref="([^"]+)"[^>]*class="[^"]*season-hover-text/);
    if (!href) continue;
    const slug = deriveSlug(decodeEntities(href));
    slugs.add(slug);

    const day = parseDay(block);
    if (day === null) continue;
    if (prevDay !== null && day !== prevDay) cursor = advanceCursor(datesAvailable, cursor, day);
    prevDay = day;
    const date = datesAvailable[cursor];
    if (!date) continue;

    const key = `${slug}|${date}`;
    if (!cards.has(key)) cards.set(key, parseCardAttrs(block));
  }
}

function parseCardAttrs(block: string): CardAttrs {
  const meta = textOf(block, /<span\s+class="meta"[^>]*>([\s\S]*?)<\/span>/);
  const { time, venueRoom } = parseMeta(meta);
  return { time, venueRoom, status: cardStatus(block) };
}

function cardStatus(block: string): RawPerformance["status"] {
  if (/\b(?:Abgesagt|Entf[äa]llt|Ausgefallen)\b/i.test(block)) return "cancelled";
  if (/Ausverkauft/i.test(block)) return "sold_out";
  if (/Restkarten/i.test(block)) return "few_left";
  return "scheduled";
}

// ── Per-production detail page ──────────────────────────────────────────────

async function scrapeProduction(
  ctx: FetchContext,
  slug: string,
  cards: Map<string, CardAttrs>,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}/de/spielplan/${slug}/`, ctx);

  const workTitle = textOf(html, /<h2>([\s\S]*?)<\/h2>/);
  if (!workTitle) return null;

  const performances = buildPerformances(html, slug, cards, window);
  if (performances.length === 0) return null;

  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: parseComposer(html),
    detail_url: `${BASE}/de/spielplan/${slug}/`,
    creative_team: parseCreativeTeam(html),
    cast: parseCast(html),
    performances,
  };
}

/**
 * `<h4>Giacomo Puccini 1858–1924</h4>` → "Giacomo Puccini". Strips life dates
 * anywhere (double bills print two composers: "Kurt Weill 1900–1950 / Carl Orff").
 */
function parseComposer(html: string): string | null {
  const raw = textOf(html, /<h2>[\s\S]*?<\/h2>\s*<h4>([\s\S]*?)<\/h4>/);
  if (!raw) return null;
  return (
    raw
      .replace(/\s*\d{4}\s*[–-]\s*\d{0,4}/g, "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

/** The creative team is a clean <dl> directly under the <h2>Besetzung</h2> heading. */
function parseCreativeTeam(html: string): RawCredit[] {
  const dl = match1(html, />Besetzung<\/h2>\s*<dl[^>]*>([\s\S]*?)<\/dl>/);
  if (!dl) return [];
  const out: RawCredit[] = [];
  for (const m of dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    const label = stripHtml(m[1] ?? "");
    const name = stripHtml(m[2] ?? "");
    if (name) out.push(normalizeGermanCredit(label, name));
  }
  return out;
}

/**
 * The sung cast lives in the "Alle Besetzungen" accordion as loose <p> blocks:
 * one role per line (split on <br>), the role label as leading text and the
 * singer(s) in <strong>. Alternates ("/ <strong>…</strong>") and date qualifiers
 * ("(1., 23.)") are emitted as separate credits / dropped respectively.
 */
function parseCast(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const body of html.matchAll(/<div class="panel-body">([\s\S]*?)<\/div>/g)) {
    // Split on <br> AND paragraph boundaries: the first sung role often abuts
    // the conductor line as "…</p> <p>Role <strong>…" with no <br> between them.
    for (const segment of (body[1] ?? "").split(/<br\s*\/?>|<\/?p[^>]*>/i)) {
      if (!/<strong>/.test(segment)) continue;
      const role = stripHtml(segment.replace(/<strong>[\s\S]*$/, ""))
        .replace(/[(:]+\s*$/, "")
        .trim();
      if (!role || GERMAN_CREDIT_LABELS[role.toLowerCase()]) continue; // creative team handled above
      for (const nameMatch of segment.matchAll(/<strong>([\s\S]*?)<\/strong>/g)) {
        const name = stripHtml(nameMatch[1] ?? "");
        const key = `${role}|${name}`;
        if (name && !seen.has(key)) {
          seen.add(key);
          out.push({ role, name });
        }
      }
    }
  }
  return out;
}

/**
 * The `calendar-list` is the authoritative date source: month columns
 * (`<span class="column-header">Mai&nbsp;2026</span>`) with one day-link each.
 * We join the spielplan card attributes (time / room / status) by (slug, date).
 */
function buildPerformances(
  html: string,
  slug: string,
  cards: Map<string, CardAttrs>,
  window: ScrapeWindow,
): RawPerformance[] {
  const list = match1(
    html,
    /<div class="section-inner calendar-list">([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/,
  );
  const region = list ?? html;
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const col of region.matchAll(
    /<span class="column-header">([\s\S]*?)<\/span>([\s\S]*?)(?=<span class="column-header">|$)/g,
  )) {
    const header = stripHtml(col[1] ?? ""); // e.g. "Mai 2026"
    const [, monthName, yearStr] = header.match(/([A-Za-zäöü.]+)\s*(\d{4})/) ?? [];
    const month = monthName ? GERMAN_MONTHS[monthName.toLowerCase().replace(/\.$/, "")] : undefined;
    if (!month || !yearStr) continue;

    for (const dayMatch of (col[2] ?? "").matchAll(/<span>\s*(\d{1,2})\.?\s*<\/span>/g)) {
      const day = dayMatch[1];
      if (!day) continue;
      const date = `${yearStr}-${month}-${day.padStart(2, "0")}` as IsoDate;
      if (window.since && date < window.since) continue;
      if (seen.has(date)) continue;
      seen.add(date);

      const attrs = cards.get(`${slug}|${date}`);
      out.push({
        date,
        time: attrs?.time ?? null,
        venue_room: attrs?.venueRoom ?? null,
        status: attrs?.status ?? (date < TODAY ? "past" : "scheduled"),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── German labels / dates ───────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);

const GERMAN_MONTHS: Record<string, string> = {
  jan: "01",
  januar: "01",
  feb: "02",
  februar: "02",
  mär: "03",
  mrz: "03",
  märz: "03",
  apr: "04",
  april: "04",
  mai: "05",
  jun: "06",
  juni: "06",
  jul: "07",
  juli: "07",
  aug: "08",
  august: "08",
  sep: "09",
  september: "09",
  okt: "10",
  oktober: "10",
  nov: "11",
  november: "11",
  dez: "12",
  dezember: "12",
};

// ── Spielplan card / spine parsing ──────────────────────────────────────────

function extractDatesAvailable(html: string): IsoDate[] {
  const arr = html.match(/var\s+dates_available\s*=\s*new\s+Array\(([^)]*)\)/)?.[1];
  if (!arr) return [];
  return [...arr.matchAll(/"(\d{4}-\d{2}-\d{2})"/g)].map((mm) => mm[1] as IsoDate);
}

/** First ISO date of each distinct YYYY-MM in the spine, in order. */
function monthStarts(dates: IsoDate[]): IsoDate[] {
  const seen = new Set<string>();
  const out: IsoDate[] = [];
  for (const d of dates) {
    const ym = d.slice(0, 7);
    if (!seen.has(ym)) {
      seen.add(ym);
      out.push(d);
    }
  }
  return out;
}

const REPERTOIRE_OPEN = /<div class="repertoire-element[^"]*">/g;

function extractRepertoireBlocks(html: string): string[] {
  const blocks: string[] = [];
  for (const match of html.matchAll(REPERTOIRE_OPEN)) {
    if (match.index === undefined) continue;
    const end = findBlockEnd(html, match.index + match[0].length);
    if (end > 0) blocks.push(html.slice(match.index, end));
  }
  return blocks;
}

/** Walk div depth from the open tag to its matching close. */
function findBlockEnd(html: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const open = html.indexOf("<div", i);
    const close = html.indexOf("</div>", i);
    if (close === -1) return -1;
    if (open !== -1 && open < close) {
      depth++;
      i = open + 4;
    } else {
      depth--;
      i = close + 6;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseDay(block: string): number | null {
  const day = block.match(/<div class="col col-date[^"]*">[^<]*<span>(\d{1,2})<\/span>/)?.[1];
  return day ? Number.parseInt(day, 10) : null;
}

function advanceCursor(dates: IsoDate[], from: number, targetDay: number): number {
  for (let i = from + 1; i < dates.length; i++) {
    const d = dates[i];
    if (d && Number.parseInt(d.slice(8, 10), 10) === targetDay) return i;
  }
  return from;
}

function parseMeta(meta: string | null): { time: string | null; venueRoom: string | null } {
  if (!meta) return { time: null, venueRoom: null };
  const timeMatch = meta.match(/(\d{1,2})[.:](\d{2})\s*Uhr/);
  const [whole, hh, mm] = timeMatch ?? [];
  const time = hh && mm ? `${hh.padStart(2, "0")}:${mm}` : null;
  const after = whole ? meta.slice(meta.indexOf(whole) + whole.length) : meta;
  const venueRoom = after.replace(/^[\s,]+|[\s,]+$/g, "").trim() || null;
  return { time, venueRoom };
}

function deriveSlug(href: string): string {
  const path = href
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/?(?:de\/)?spielplan\//, "")
    .split("?")[0];
  return (path ?? "").replace(/^\/+|\/+$/g, "");
}

function match1(text: string, re: RegExp): string | null {
  return text.match(re)?.[1] ?? null;
}

function matchAttr(text: string, re: RegExp): string | null {
  return text.match(re)?.[1] ?? null;
}

function textOf(text: string, re: RegExp): string | null {
  const g = text.match(re)?.[1];
  return g != null ? stripHtml(g) : null;
}
