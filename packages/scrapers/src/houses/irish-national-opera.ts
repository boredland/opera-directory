import type { IsoDate, LangCode } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";

/**
 * Irish National Opera (`spielplan-html`) — Ireland's national company (founded
 * 2018, Dublin), which tours nationally rather than running a single resident
 * house. NOT a festival: a year-round season, so the live scrape = the announced
 * future, and `backfill` walks the company's own past-productions archive.
 *
 * Craft CMS, English site, plain fetch (200 to the crawler UA, no proxy). No
 * schema.org Event JSON-LD, so everything is parsed from SSR HTML:
 *   - The hub `/whats-on/current-upcoming` links detail pages
 *     `/whats-on/current-upcoming/{slug}`; the bounded `/whats-on/past-productions`
 *     page (no pagination) lists the full historical set under the same path.
 *   - Detail page: work title in `<h1>`, composer in the FIRST `<h2 class="…
 *     fw-normal…">` after it (an ENGLISH byline — librettist co-credits like
 *     "Tarik O'Regan & Colm Tóibín" are split on &/and/slash, composer first).
 *     The `<ul class="list-meta">` carries a "Month YYYY" chip used to date the
 *     schedule rows (which print no year) and a city.
 *   - Opera filter: a person-name composer h2 must be present AND the title must
 *     not read as a gala/concert/screening/talk — drops the company's galas,
 *     concerts, outdoor screenings, talks and outreach while keeping the staged
 *     operas (incl. contemporary commissions).
 *   - Cast / Creative Team live in two `<table class="table">`s under
 *     `<h3 class="section-heading">Cast</h3>` / `Creative Team`, each row two
 *     `<td>`s (role|name, label|name). English labels are mapped in-adapter;
 *     ensemble rows (Orchestra & Chorus) and "TBC" placeholders are dropped.
 *   - Performances sit in `<table class="table-schedule">` rows: a
 *     `<span class="date">Mon 2 November</span>` + `<span class="time">7.30pm</span>`
 *     + a `td-details` venue. Touring runs carry several schedule tables; the year
 *     for each row is resolved from the page's "Month YYYY" tokens.
 *   - Wikidata has no entity for INO (too new), so there is no SPARQL backfill —
 *     the company archive is the historical source.
 */

const BASE = "https://www.irishnationalopera.ie";
const HUB = `${BASE}/whats-on/current-upcoming`;
const ARCHIVE = `${BASE}/whats-on/past-productions`;

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** English creative-team labels → our canonical function slugs. Unmapped labels
 *  (video/projection/assistant repetiteur …) are dropped as credits we don't model. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "associate conductor": "conductor",
  "assistant conductor": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  designer: "set-designer",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "set & costume designer": "set-designer",
  "set and costume designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "choreographer / movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
  dramaturgy: "dramaturgy",
};

/** Languages INO prints in its "sung in {X}" surtitle line → LangCode. */
const SUNG_LANGUAGES: Record<string, LangCode> = {
  french: "fr",
  italian: "it",
  german: "de",
  english: "en",
  russian: "ru",
  czech: "cs",
};

const NON_OPERA_TITLE =
  /\b(gala|concert|screening|recital|masterclass|fundrais|quiz|talk|tour|workshop|class|celebration|conversation)\b/i;

export async function scrapeIrishNationalOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const slugs = await collectSlugs(ctx, window.mode === "backfill");
    for (const slug of slugs) {
      try {
        const html = await fetchHtml(`${HUB}/${slug}`, ctx);
        const prod = parseEvent(html, slug);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`irish-national-opera: event ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("irish-national-opera: live scrape failed:", err);
  }

  return { house_slug: "irish-national-opera", productions };
}

/** Detail slugs from the upcoming hub, plus the bounded past-productions archive
 *  in backfill mode. All detail pages live under /whats-on/current-upcoming/. */
async function collectSlugs(ctx: FetchContext, includeArchive: boolean): Promise<string[]> {
  const slugs = new Set<string>();
  const pages = includeArchive ? [HUB, ARCHIVE] : [HUB];
  for (const page of pages) {
    const html = await fetchHtml(page, ctx);
    for (const [, slug] of html.matchAll(/\/whats-on\/current-upcoming\/([^"'?#/\s]+)/g)) {
      if (slug && slug !== "current-upcoming-productions") slugs.add(decodeURIComponent(slug));
    }
  }
  return [...slugs];
}

function parseEvent(html: string, slug: string): RawProduction | null {
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "")
    .replace(/^['‘’"“]|['‘’"”]$/g, "")
    .trim();
  if (!title || NON_OPERA_TITLE.test(title)) return null;

  const composer = composerFromHeading(html);
  if (!composer) return null;

  const monthYear = monthYearMap(html);
  const performances = parsePerformances(html, monthYear);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `irish-national-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${HUB}/${slug}`,
    image_url: ogImage(html),
    language: sungLanguage(html),
    is_revival: creative_team.some((c) => /revival/i.test(c.function ?? "")) || undefined,
    creative_team,
    cast,
    performances,
  };
}

/** Composer = the first non-section `<h2 class="…fw-normal…">` after the title,
 *  validated as a person name. Co-credits ("Composer & Librettist") are split on
 *  &/and/slash and the first segment kept. Falls back to the list-meta chip. */
function composerFromHeading(html: string): string | null {
  const after = html.slice(html.indexOf("<h1"));
  const raw =
    after.match(/<h2[^>]*class="[^"]*fw-normal[^"]*"[^>]*>([\s\S]*?)<\/h2>/)?.[1] ??
    html.match(/<ul[^>]*list-meta[^>]*>\s*<li[^>]*>([\s\S]*?)<\/li>/)?.[1];
  if (!raw) return null;
  const text = stripHtml(raw);
  // The list-meta fallback chip can hold a genre descriptor ("Concert
  // Performance") rather than a composer — those read like a name but aren't one.
  if (EVENT_FORM.test(text)) return null;
  const first = text.split(/\s*(?:&|\/| and )\s*/i)[0]?.trim();
  return first && looksLikePersonName(first) ? first : null;
}

const EVENT_FORM = /\b(concert|performance|recital|gala|cycle|celebration|conversation)\b/i;

const NAME_PARTICLES = new Set([
  "von",
  "van",
  "de",
  "da",
  "di",
  "del",
  "della",
  "der",
  "den",
  "le",
  "la",
  "y",
]);

function looksLikePersonName(text: string): boolean {
  if (/^\d/.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length < 1 || words.length > 5) return false;
  return words.every((w) => {
    const bare = w.replace(/[.'’-]/g, "");
    if (!bare) return true;
    if (NAME_PARTICLES.has(bare.toLowerCase())) return true;
    return /^\p{Lu}/u.test(bare);
  });
}

function ogImage(html: string): string | null {
  return (
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1] ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)?.[1] ??
    null
  );
}

function sungLanguage(html: string): LangCode | null {
  const m = stripHtml(html).match(/sung in ([A-Za-z]+)/i);
  return m ? (SUNG_LANGUAGES[(m[1] ?? "").toLowerCase()] ?? null) : null;
}

/** Build a month-name → year map from every "Month YYYY" token on the page (the
 *  list-meta chip and the date-range headings), so each schedule row's bare
 *  "Mon 2 November" resolves to the right year even across a year boundary. */
function monthYearMap(html: string): { byMonth: Record<number, number>; fallback: number } {
  const text = stripHtml(html);
  const byMonth: Record<number, number> = {};
  let fallback = 0;
  for (const m of text.matchAll(/\b([A-Za-z]{3,})\s+(20\d{2})\b/g)) {
    const month = MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()];
    const year = Number.parseInt(m[2] ?? "", 10);
    if (month && year) {
      byMonth[month] ??= year;
      if (!fallback) fallback = year;
    }
  }
  return { byMonth, fallback: fallback || new Date().getFullYear() };
}

function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const cast: RawCredit[] = [];
  for (const [role, name] of sectionTableRows(html, "Cast")) {
    if (role && isRealName(name) && !/orchestra|chorus|ensemble/i.test(`${role} ${name}`)) {
      cast.push({ role, name });
    }
  }

  const creative_team: RawCredit[] = [];
  for (const [label, name] of sectionTableRows(html, "Creative Team")) {
    const fn = CREATIVE_FUNCTIONS[(label ?? "").toLowerCase().trim()];
    if (fn && isRealName(name)) creative_team.push({ function: fn, name });
  }

  return { creative_team, cast };
}

/** Two-column `<td>` rows of the `<table class="table">` that follows the
 *  `<h3 class="section-heading">{heading}</h3>` (Cast / Creative Team). */
function sectionTableRows(html: string, heading: string): [string, string][] {
  const h3 = new RegExp(
    `<h3[^>]*class="[^"]*section-heading[^"]*"[^>]*>\\s*${heading}\\s*</h3>`,
  ).exec(html);
  if (!h3) return [];
  const start = html.indexOf("<table", h3.index);
  if (start < 0) return [];
  const end = html.indexOf("</table>", start);
  const seg = html.slice(start, end < 0 ? undefined : end);

  const rows: [string, string][] = [];
  for (const [, body] of seg.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(body ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      stripHtml(m[1] ?? ""),
    );
    if (cells.length >= 2 && cells[0] && cells[1]) rows.push([cells[0], cells[1]]);
  }
  return rows;
}

function isRealName(name: string): boolean {
  return Boolean(name) && !/^tbc$/i.test(name.trim());
}

/** Every `<table class="table-schedule">` row → one performance. The desktop and
 *  mobile layouts each repeat the date/time spans, so rows are deduped on
 *  date+time. Year per row comes from the month → year map. */
function parsePerformances(
  html: string,
  monthYear: { byMonth: Record<number, number>; fallback: number },
): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, table] of html.matchAll(
    /<table[^>]*class="[^"]*table-schedule[^"]*"[^>]*>([\s\S]*?)<\/table>/g,
  )) {
    for (const [, body] of (table ?? "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const dateText = (body ?? "").match(
        /<span[^>]*class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/span>/,
      )?.[1];
      const date = dateText ? parseDate(stripHtml(dateText), monthYear) : null;
      if (!date) continue;

      const venue_room = venueFromRow(body ?? "");
      // Schedule tables interleave ancillary rows under the same date — a pricing
      // note ("Student Ticket includes TM booking fee") and accessibility lines
      // ("Audio Described Performance +353 …"). They carry a date but a note, not
      // a venue, so the venue text is what tells them apart from a real night.
      if (venue_room && isNoteRow(venue_room)) continue;

      const timeText = (body ?? "").match(
        /<span[^>]*class="[^"]*time[^"]*"[^>]*>([\s\S]*?)<\/span>/,
      )?.[1];
      const time = timeText ? parseTime(stripHtml(timeText)) : null;
      const status = nightStatus(date);

      const key = `${date}|${time ?? ""}|${venue_room ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date, time, venue_room, status });
    }
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

const NOTE_ROW =
  /\bticket|booking fee|audio[- ]described|captioned|relaxed performance|wheelchair|@|\+?\d{3}|option \d|call ?\/ ?email/i;

/** A schedule sub-row whose "venue" is actually a pricing / accessibility note. */
function isNoteRow(venue: string): boolean {
  return NOTE_ROW.test(venue);
}

/** The `td-details` cell's text minus its mobile date/time `div.d-xl-none`,
 *  yielding "{City} {Venue}". */
function venueFromRow(body: string): string | null {
  const td = body.match(/<td[^>]*class="[^"]*td-details[^"]*"[^>]*>([\s\S]*?)<\/td>/)?.[1];
  if (!td) return null;
  const text = stripHtml(
    td.replace(/<div[^>]*class="[^"]*d-xl-none[^"]*"[^>]*>[\s\S]*?<\/div>/g, ""),
  );
  return text || null;
}

/** "Mon 2 November" → "2026-11-02"; weekday ignored, year from the month map. */
function parseDate(
  text: string,
  monthYear: { byMonth: Record<number, number>; fallback: number },
): IsoDate | null {
  const m = decodeEntities(text).match(/\b(\d{1,2})\s+([A-Za-z]{3,})/);
  if (!m) return null;
  const day = Number.parseInt(m[1] ?? "", 10);
  const month = MONTHS[(m[2] ?? "").slice(0, 3).toLowerCase()];
  if (!month || day < 1 || day > 31) return null;
  const year = monthYear.byMonth[month] ?? monthYear.fallback;
  return isoFromParts(year, month, day);
}

/** "7.30pm" → "19:30"; "8pm" → "20:00"; "11am" → "11:00". */
function parseTime(text: string): string | null {
  const m = text.match(/\b(\d{1,2})(?:[.:](\d{2}))?\s*([ap]m)\b/i);
  if (!m) return null;
  let hour = Number.parseInt(m[1] ?? "", 10);
  if (Number.isNaN(hour)) return null;
  const isPm = (m[3] ?? "").toLowerCase() === "pm";
  if (isPm && hour < 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${(m[2] ?? "00").padStart(2, "0")}`;
}

function nightStatus(date: IsoDate): RawPerformance["status"] {
  return date < new Date().toISOString().slice(0, 10) ? "past" : "scheduled";
}
