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
 * Wexford Festival Opera (`spielplan-html` strategy) — Ireland's autumn opera
 * festival (Wexford), staged each year ~late-October–November and celebrated for
 * rare and neglected operas. A FESTIVAL: one edition at a time, so the live
 * scrape = the CURRENT edition's staged opera; `backfill` appends Wikidata for
 * the historical long tail.
 *
 * Craft CMS, English site, served 200 to the project crawler UA (no proxy). The
 * page's only JSON-LD is Organization/Article boilerplate (no schema.org Event),
 * so everything is parsed from the SSR HTML:
 *   - The hub `/programme/festival-programme/` links to detail pages at
 *     `/programme/festival-programme/{slug}`.
 *   - Each detail page titles the work in `<h1 class="…mobile-h1">` and prints the
 *     composer in the FINAL `<h2 class="…serif">` (an ENGLISH byline, not the
 *     German composerFromText). Some pages carry a leading tagline h2 ("World
 *     Premiere") before the composer — hence the *last* serif h2.
 *   - The opera filter: the page must have a serif-h2 composer AND that text must
 *     read like a person's name (all-capitalised words, no leading digit, ≤5
 *     words), AND no serif h2 may carry an event-form keyword (concert, recital,
 *     song cycle, gala, lecture, tour, …). This drops the festival's concerts,
 *     recitals, galas, lectures, tastings, tours and song cycles (which either
 *     lack a serif h2, put a tagline there — "A tasting in honour of …", "75th
 *     Anniversary Fundraising Gala", "Choral Concert" — or flag the form alongside
 *     a real librettist's name — "(Song Cycle)" / Colm Tóibín) while keeping the
 *     main staged operas and the shorter Pocket / Community Operas.
 *   - Cast / Creative Team sit in `<table>`s captioned "Cast includes" /
 *     "Creative Team includes", each row two `<td>`s (role|name, label|name).
 *     English function labels are mapped INSIDE this adapter. "TBC" placeholders
 *     are dropped.
 *   - Performance dates live in a "Dates and times" booking table ("Sunday 18
 *     Oct" + a "5pm"/"7:30pm" time + a "Book"/"Sold Out" status). The year is
 *     absent from the table; it is read from the date-range line ("… October
 *     2026"), falling back to the /events/{year}/ image path.
 */

const BASE = "https://www.wexfordopera.com";
const HUB = `${BASE}/programme/festival-programme`;
/** Wexford Festival Opera on Wikidata. Verified via wbsearchentities:
 *  Q1463492 = "Wexford Festival Opera", description "opera festival in Ireland". */
const WIKIDATA_QID = "Q1463492";

/** Main stage and the studio space, both inside the National Opera House. */
const DEFAULT_VENUE = "National Opera House";

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

/** English creative-team labels → our canonical function slugs. Wexford prints a
 *  combined "Set & Costume Designer" credit, folded to set-designer like the cast
 *  block does at Glyndebourne. Labels not in this map are ignored as production
 *  credits we don't model. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
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
  "lighting designers": "lighting",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
  dramaturgy: "dramaturgy",
};

export async function scrapeWexfordFestivalOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const slugs = await collectEventSlugs(ctx);
    for (const slug of slugs) {
      try {
        const html = await fetchHtml(`${HUB}/${slug}`, ctx);
        const prod = parseEvent(html, slug);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`wexford-festival-opera: event ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("wexford-festival-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("wexford-festival-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "wexford-festival-opera", productions };
}

/** Collect unique `/programme/festival-programme/{slug}` detail slugs from the
 *  hub, dropping the hub's own non-production sub-pages (calendar, how-to-book). */
async function collectEventSlugs(ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(HUB, ctx);
  const slugs = new Set<string>();
  for (const [, slug] of html.matchAll(
    /href="https:\/\/www\.wexfordopera\.com\/programme\/festival-programme\/([^"?/]+)"/g,
  )) {
    if (slug && !/^(calendar|how-to-book|watch-anytime)/.test(slug)) slugs.add(slug);
  }
  return [...slugs];
}

function parseEvent(html: string, slug: string): RawProduction | null {
  const title = stripHtml(
    html.match(/<h1[^>]*class="[^"]*mobile-h1[^"]*"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "",
  )
    .replace(/^['‘’]|['‘’]$/g, "")
    .trim();
  if (!title) return null;

  const composer = composerFromSerifH2(html);
  // No composer-shaped serif h2 ⇒ a concert / recital / gala / lecture / tasting.
  if (!composer) return null;

  const year = festivalYear(html);
  const performances = parsePerformances(html, year);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `wexford/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${HUB}/${slug}`,
    image_url: heroImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** The composer is the FINAL `<h2 class="…serif">` after the title — a leading
 *  tagline h2 ("World Premiere") can precede it. It only counts when it reads
 *  like a person's name: ≤5 words, no leading digit, every word capitalised
 *  (particles like von/de allowed). That rejects taglines such as "A tasting in
 *  honour of Sir Compton Mackenzie" or "75th Anniversary Fundraising Gala". */
function composerFromSerifH2(html: string): string | null {
  const after = html.slice(html.indexOf("<h1"));
  const h2s = [...after.matchAll(/<h2[^>]*class="[^"]*serif[^"]*"[^>]*>([\s\S]*?)<\/h2>/g)]
    .map((m) => stripHtml(m[1] ?? ""))
    .filter(Boolean);
  // Any event-form keyword across the serif h2s marks a concert/recital/cycle,
  // even when a real (libretto) author's name sits alongside it.
  if (h2s.some(isEventForm)) return null;
  const candidate = h2s.pop();
  if (!candidate || !looksLikePersonName(candidate)) return null;
  return candidate;
}

const EVENT_FORM =
  /\b(concert|recital|gala|cycle|lecture|tour|tasting|party|interview|talk|breakfast|packages?|events?|premiere)\b/i;

/** "World Premiere" is fine as a leading tagline (the composer h2 follows it), so
 *  treat a bare "premiere" only when it co-occurs with another form word — but the
 *  cheap test below is enough in practice: a serif h2 that is *only* a tagline
 *  never doubles as the composer, and the composer h2 carries no form keyword. */
function isEventForm(text: string): boolean {
  if (/^world premiere$/i.test(text.trim())) return false;
  return EVENT_FORM.test(text);
}

/** The detail page's own hero sits in `<figure class="photo mb-5 …">`; the
 *  smaller `mb-2` figures are "more from the programme" cards we must not pick. */
function heroImage(html: string): string | null {
  return (
    html.match(
      /<figure class="photo mb-5[\s\S]*?src="(https:\/\/[^"]*Programme-Images[^"]*\.jpg[^"]*)"/,
    )?.[1] ?? null
  );
}

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
  "ten",
  "ter",
  "le",
  "la",
  "y",
  "und",
  "and",
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

/** Year from the date-range line ("… October 2026"); falls back to the
 *  /events/{year}/ image path, then the current year. */
function festivalYear(html: string): number {
  const fromRange = html.match(/\b(20\d{2})\b\s*<\/div>/)?.[1];
  const fromPath = html.match(/\/content\/events\/(20\d{2})\//)?.[1];
  return Number.parseInt(fromRange ?? fromPath ?? "", 10) || new Date().getFullYear();
}

function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const cast: RawCredit[] = [];
  for (const [role, name] of tableRows(html, "Cast includes")) {
    if (role && isRealName(name)) cast.push({ role, name });
  }

  const creative_team: RawCredit[] = [];
  for (const [label, name] of tableRows(html, "Creative Team includes")) {
    const fn = CREATIVE_FUNCTIONS[(label ?? "").toLowerCase()];
    if (fn && isRealName(name)) creative_team.push({ function: fn, name });
  }

  return { creative_team, cast };
}

/** Two-column rows (`<tr class="normal-row">` of `<td>`s) under a captioned
 *  table. Returns [first, second] cell text per row. */
function tableRows(html: string, caption: string): [string, string][] {
  const start = html.indexOf(caption);
  if (start < 0) return [];
  const end = html.indexOf("</table>", start);
  const seg = html.slice(start, end < 0 ? undefined : end);
  const rows: [string, string][] = [];
  for (const [, body] of seg.matchAll(/<tr class="normal-row">([\s\S]*?)<\/tr>/g)) {
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

/** "Dates and times" booking table: first `<td>` is "Sunday 18 Oct" (+ a mobile
 *  time), a later `<td>` repeats the time ("5pm"/"7:30pm"), and the final `<td>`
 *  is the booking status ("Book"/"Sold Out"). The year comes from the caller. */
function parsePerformances(html: string, year: number): RawPerformance[] {
  const start = html.indexOf("Dates and times");
  if (start < 0) return [];
  const end = html.indexOf("</table>", start);
  const seg = html.slice(start, end < 0 ? undefined : end);

  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const [, body] of seg.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(body ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      stripHtml(m[1] ?? ""),
    );
    if (cells.length === 0) continue;

    const date = parseDate(cells[0] ?? "", year);
    if (!date) continue;

    const time = parseTime(cells.join(" "));
    const booking = cells[cells.length - 1] ?? "";
    const status = /sold\s*out/i.test(booking) ? "sold_out" : nightStatus(date);

    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, venue_room: DEFAULT_VENUE, status });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** "Sunday 18 Oct" → "2026-10-18" (weekday ignored; month from the abbrev). */
function parseDate(text: string, year: number): IsoDate | null {
  const m = decodeEntities(text).match(/\b(\d{1,2})\s+([A-Za-z]{3,})/);
  if (!m) return null;
  const day = Number.parseInt(m[1] ?? "", 10);
  const month = MONTHS[(m[2] ?? "").slice(0, 3).toLowerCase()];
  if (!month || day < 1 || day > 31) return null;
  return isoFromParts(year, month, day);
}

/** "7:30pm" → "19:30"; "5pm" → "17:00"; "11am" → "11:00". */
function parseTime(text: string): string | null {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i);
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
