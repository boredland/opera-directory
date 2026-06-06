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
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Rossini in Wildbad — the Belcanto Opera Festival in Bad Wildbad, dedicated to
 * Rossini & belcanto (`spielplan-html`, WordPress + Divi/Elegant Themes).
 *
 * FESTIVAL — one edition staged each July; the site empty of programme the rest
 * of the year. The live leg is the CURRENT edition only, driven off the year's
 * calendar page (`/kalender-{YEAR}/`): a Divi grid of rows, each carrying a work
 * title (+ German subtitle), a "📅 {DD}. {Monat} {YEAR} 🕢 {HH:MM}" date/time
 * line, and a "weiterlesen" link to the work's detail page (`/{slug}/`). Rows are
 * grouped by `{slug}` into one production with all its dated performances; the
 * deep past comes from Wikidata backfill (Q2167718).
 *
 * Opera gate: the calendar mixes staged operas with concerts, recitals, galas, a
 * children's theatre piece and a concertante zarzuela. A slug is kept only when
 * its detail page is a STAGED opera — flagged by a "BESETZUNG" cast block plus a
 * director credit ("Regie"/"Inszenierung"), corroborated by the Yoast keywords
 * carrying a staged-opera marker ("…oper") that is NOT "konzertante". That keeps
 * the three staged operas (L'occasione fa il ladro, La gazza ladra, Le mariage
 * en poste) and drops the Waldkonzert, "Rossini & Co", Serenade, "¡Rossini olé!",
 * the "Marina" concertante zarzuela, the Rossini-Büffet and the Kindertheater.
 *
 * Composer: the festival stages only Rossini operas and prints no work-type/
 * composer byline, so composer defaults to Gioachino Rossini.
 *
 * Cast/credits: the BESETZUNG block is a `<p>` of `Label, Name<br/>` rows — sung
 * roles ("Don Parmenione, Filippo Morace") and creative functions in German
 * ("Musikalische Leitung", "Dirigent", "Regie und Bühne", "Kostüme", "Licht",
 * "Fortepiano"). A conductor may be split across per-date tags ("28.7. | 29.7.")
 * on the following line; those bare date-lines carry no credit and are skipped.
 * Venue (Königliches Kurtheater / Kursaal) rides in the Yoast keywords.
 */

const BASE = "https://rossini-in-wildbad.de";
/** Rossini in Wildbad on Wikidata — verified via wbsearchentities; P31 = music
 *  festival (Q868557), P17 = Germany (Q183), P276 = Bad Wildbad (Q502755). */
const WIKIDATA_QID = "Q2167718";

const DEFAULT_COMPOSER = "Gioachino Rossini";

const MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  märz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  aug: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

/** Known performance venues (matched in the Yoast keywords); the main staged-
 *  opera house is the Königliches Kurtheater. */
const VENUES = ["Königliches Kurtheater", "Kursaal", "Trinkhalle", "Forum König-Karls-Bad"];

interface CalEntry {
  slug: string;
  title: string;
  date: IsoDate;
  time: string | null;
}

export async function scrapeRossiniInWildbad(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const bySlug = await parseCalendar(ctx, window);
    for (const [slug, perfs] of bySlug) {
      try {
        const prod = await buildProduction(ctx, slug, perfs);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`rossini-in-wildbad: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("rossini-in-wildbad: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("rossini-in-wildbad: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "rossini-in-wildbad", productions };
}

/** Find the current edition's calendar (July festival → current year, with the
 *  next/previous year as fallback once an edition publishes early or lingers),
 *  and group its performance rows by detail-page slug. */
async function parseCalendar(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<Map<string, RawPerformance[]>> {
  const thisYear = new Date().getUTCFullYear();
  for (const year of [thisYear, thisYear + 1, thisYear - 1]) {
    try {
      const html = await fetchHtml(`${BASE}/kalender-${year}/`, ctx);
      const entries = parseCalendarRows(html);
      if (entries.length > 0) return groupEntries(entries, window);
    } catch {
      // try next candidate year
    }
  }
  return new Map();
}

/**
 * Each Divi row holds a "📅 {DD}. {Monat} {YEAR} 🕢 {HH:MM}" date/time line and a
 * `href="{BASE}/{slug}/">weiterlesen` link. The title text precedes the date but
 * isn't reliably scoped to the row, so we read date/time + slug here and take the
 * canonical title from the detail page later. Date-ranges ("20. bis 24. Juli",
 * the children's-theatre run) and time-less rows are emitted with what's present.
 */
function parseCalendarRows(html: string): CalEntry[] {
  const out: CalEntry[] = [];
  // Each row's "📅 {date} 🕢 {time}" line and its "weiterlesen" link sit together,
  // but Divi sprays `</strong><strong>` + &nbsp; through the date text — so per
  // row, strip tags before reading the date. Anchor on the link and read the LAST
  // date/time in the text preceding it (the row's own line).
  const linkRe = /href="https:\/\/rossini-in-wildbad\.de\/([a-z0-9-]+)\/">weiterlesen/g;
  let prevEnd = 0;
  for (const m of html.matchAll(linkRe)) {
    const slug = m[1];
    const row = stripHtml(decodeEntities(html.slice(prevEnd, m.index ?? 0)));
    prevEnd = (m.index ?? 0) + m[0].length;
    if (!slug) continue;

    const dateMatches = [...row.matchAll(/📅\s*(\d{1,2})\s*\.\s*([A-Za-zÄÖÜäöü]+)\s*(\d{4})/g)];
    const dm = dateMatches.at(-1);
    if (!dm) continue;
    const [, dd, monthName, yyyy] = dm;
    const mm = MONTHS[(monthName ?? "").toLowerCase()];
    if (!mm || !dd || !yyyy) continue;

    const times = [...row.matchAll(/🕢\s*(\d{1,2}:\d{2})/g)];
    out.push({
      slug,
      title: "",
      date: `${yyyy}-${mm}-${dd.padStart(2, "0")}` as IsoDate,
      time: times.at(-1)?.[1] ?? null,
    });
  }
  return out;
}

function groupEntries(entries: CalEntry[], window: ScrapeWindow): Map<string, RawPerformance[]> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, RawPerformance[]>();
  for (const e of entries) {
    if (window.since && e.date < window.since) continue;
    const perfs = bySlug.get(e.slug) ?? [];
    perfs.push({ date: e.date, time: e.time, status: e.date < today ? "past" : "scheduled" });
    bySlug.set(e.slug, perfs);
  }
  for (const perfs of bySlug.values()) {
    perfs.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
  }
  return bySlug;
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  performances: RawPerformance[],
): Promise<RawProduction | null> {
  if (performances.length === 0) return null;
  const url = `${BASE}/${slug}/`;
  const html = await fetchHtml(url, ctx);

  const keywords = parseKeywords(html);
  const castBlock = extractCastBlock(html);
  if (!isStagedOpera(keywords, castBlock)) return null;

  const { cast, creative } = parseCredits(castBlock ?? "");
  const title = parseTitle(html);
  if (!title) return null;

  const venue = pickVenue(keywords);
  const withVenue = venue ? performances.map((p) => ({ ...p, venue_room: venue })) : performances;

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: DEFAULT_COMPOSER,
    premiere_season: performances[0]?.date.slice(0, 4) ?? null,
    is_revival: /wiederaufnahme|riallestimento|ripresa/i.test(html),
    detail_url: url,
    creative_team: creative,
    cast,
    performances: withVenue,
  };
}

/** Yoast tags the page with comma-separated keywords (one item may itself be a
 *  ";"-joined list); flatten both separators into a lowercased list. */
function parseKeywords(html: string): string[] {
  const m = html.match(/"keywords":\[(.*?)\]/);
  if (!m?.[1]) return [];
  return m[1]
    .split(/","|"\s*,\s*"/)
    .flatMap((k) => k.replace(/^"|"$/g, "").split(";"))
    .map((k) => decodeEntities(k).trim().toLowerCase())
    .filter(Boolean);
}

/** A staged opera carries a German "…oper" keyword that isn't a concertante
 *  billing, plus a director credit in its cast block. Both guards drop the
 *  festival's concerts/recitals/galas and the concertante zarzuela. */
function isStagedOpera(keywords: string[], castBlock: string | null): boolean {
  const stagedKeyword = keywords.some(
    (k) => /\boper\b|szenische oper|salonoper|klavieroper/.test(k) && !/konzertante/.test(k),
  );
  const directed = !!castBlock && /\b(regie|inszenierung)\b/i.test(castBlock);
  return stagedKeyword && directed;
}

/** Slice the cast text from the "BESETZUNG" heading to the next section heading
 *  ("TICKETS, ZEITPLAN…"). Returns the raw HTML so `<br/>`-separated rows survive. */
function extractCastBlock(html: string): string | null {
  const start = html.search(/BESETZUNG/);
  if (start === -1) return null;
  const rest = html.slice(start);
  const end = rest.search(/TICKETS,?\s*ZEITPLAN|ZEITPLAN UND INFORMATIONEN/i);
  return end === -1 ? rest.slice(0, 6000) : rest.slice(0, end);
}

/** The Divi page has no content `<h1>`; the canonical title is the Yoast
 *  Article `headline` (and the og:title, minus the site suffix). */
function parseTitle(html: string): string | null {
  const headline = html.match(/"headline":"((?:[^"\\]|\\.)*)"/)?.[1];
  if (headline) {
    const t = decodeEntities(headline.replace(/\\\//g, "/").replace(/\\u2019/g, "’")).trim();
    if (t) return t;
  }
  const og = html.match(/"og:title"\s+content="([^"]+)"/)?.[1];
  return og
    ? decodeEntities(og)
        .split(/\s*[-–]\s*Belcanto/)[0]
        ?.trim() || null
    : null;
}

/** Match a venue from the keywords; the opera house is keyworded as the bare
 *  "Kurtheater" (the Königliches Kurtheater), so match on the distinctive token. */
function pickVenue(keywords: string[]): string | null {
  const has = (needle: string) => keywords.some((k) => k.includes(needle));
  for (const v of VENUES) if (has(v.toLowerCase())) return v;
  if (has("kurtheater")) return "Königliches Kurtheater";
  return null;
}

/**
 * Parse the BESETZUNG block's `Label, Name<br/>` rows: a row whose label maps to
 * a German creative function is a creative credit, otherwise it's a sung role.
 * Bare date-tag lines ("28.7. | 29.7. | 2.8.2026") qualify a preceding conductor
 * and carry no name — skipped. Ensemble lines (chorus/orchestra) are dropped.
 */
function parseCredits(block: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();

  for (const raw of block.split(/<br\s*\/?>|<\/p>\s*<p>/i)) {
    const line = stripHtml(decodeEntities(raw))
      .replace(/^\s*BESETZUNG\s*/i, "")
      .trim();
    if (!line) continue;
    // A bare date-tag line (digits, dots, pipes, year) belongs to the prior credit.
    if (/^[\d.\s|]+$/.test(line)) continue;

    const ci = line.indexOf(",");
    if (ci === -1) continue;
    const label = line.slice(0, ci).trim();
    // Cut the "*Mitwirkende der Akademie BelCanto" footnote that trails the last row.
    const value = line
      .slice(ci + 1)
      .split(/\*?\s*Mitwirkende der Akademie/i)[0]
      ?.trim();
    if (!label || !value) continue;

    const credit = mapCredit(label, value);
    if (credit.function) {
      for (const name of splitNames(value)) {
        push(creative, seen, `${credit.function}|${name}`, { function: credit.function, name });
      }
    } else {
      // Drop ensemble rows (chorus/orchestra) — not individual performers.
      if (/\b(chor|orchester|coro|orchestra|filharmoni|philharmoni)\b/i.test(value)) continue;
      for (const name of splitNames(value)) {
        push(cast, seen, `${label}|${name}`, { role: label, name });
      }
    }
  }
  return { cast, creative };
}

/** The festival prints a few combined/variant creative labels the shared German
 *  map doesn't carry ("Regie und Bühne", "Regie mit Ideen von …", "Kostüme nach
 *  X", "Fortepiano"/"Klavier"). Normalize those in-adapter, then fall back to the
 *  shared map; an unmapped label drops through to a verbatim sung-role credit. */
function mapCredit(label: string, value: string): RawCredit {
  const l = label.toLowerCase();
  if (/\bregie\b/.test(l)) return { function: "director", name: value };
  if (/^kost[üu]m/.test(l)) return { function: "costume-designer", name: value };
  if (/^fortepiano$|^klavier$|^cembalo$/.test(l)) return { function: "continuo", name: value };
  return normalizeGermanCredit(label, value);
}

function push(out: RawCredit[], seen: Set<string>, key: string, credit: RawCredit): void {
  if (seen.has(key)) return;
  seen.add(key);
  out.push(credit);
}

/** A credit value may list several people ("X und Y", "X, Y"); split and strip
 *  the Akademie-BelCanto asterisk marker and parenthetical date tags. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+und\s+/)
    .map((s) =>
      s
        .replace(/\([^)]*\)/g, "")
        .replace(/\*+/g, "")
        .trim(),
    )
    .filter((s) => s.length >= 2 && !/^nach\b/i.test(s));
}
