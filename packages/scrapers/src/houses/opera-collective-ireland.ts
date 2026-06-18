import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";

/**
 * Opera Collective Ireland (`spielplan-html`) — a Dublin/Carlingford company
 * (formerly Irish Youth Opera) staging baroque and chamber opera with emerging
 * Irish artists, touring a handful of productions a year (Pavilion Dún Laoghaire,
 * Kilkenny Arts Festival, Smock Alley …).
 *
 * WordPress (Uncode/WPBakery theme), English, plain fetch (Cloudflare but 200 to
 * the crawler UA, no proxy). Productions are a `production` custom post type, so
 * discovery is the WP REST API; the detail pages are WPBakery-rendered HTML with
 * no schema.org Event and an EMPTY ACF, so title/composer/dates are parsed there:
 *   - Discovery: `/wp-json/wp/v2/production?per_page=100` → slug + title (the
 *     whole catalogue is ~14 items, so it is fetched in full in both modes).
 *   - Detail page: `<h1>` work title (taken from the REST title), the composer is
 *     the first person-name text node after it, then a date-range `<span>`
 *     ("4 August – 3 September 2022" / "25–27 SEPTEMBER 2026") that carries the
 *     year(s).
 *   - "Dates & Venues" block: dates appear either as full weekday dates ("Friday
 *     25 September 2026") or as a day-list grouped by venue ("4, 5, 7 August –
 *     Kilkenny Arts Festival, Watergate Theatre"). One "{days} {month}" pattern
 *     covers both; the year comes from the trailing YYYY when present, else the
 *     month→year map built from the date-range heading. Each date group is tied
 *     to the nearest venue (`<strong>`/`<a>` with a venue keyword) by position.
 *   - The pages carry NO structured cast/creative team (singer names appear only
 *     in press-quote prose), so productions are emitted with composer +
 *     performances and no credits — faithful to what the page states.
 *   - Opera gate: a person-name composer AND ≥1 performance date — drops the
 *     company's Christmas "celebration in word & song" concert.
 */

const BASE = "https://operacollectiveireland.com";
const REST = `${BASE}/wp-json/wp/v2/production?per_page=100&_fields=slug,title`;

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const VENUE_KEYWORD =
  /theatre|theater|pavilion|festival|hall|church|centre|center|arts|court|smock alley|watergate|cathedral|chapel|opera house/i;

interface RestProduction {
  slug: string;
  title: { rendered: string };
}

export async function scrapeOperaCollectiveIreland(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let catalogue: RestProduction[] = [];
  try {
    catalogue = await fetchJson<RestProduction[]>(REST, ctx);
  } catch (err) {
    console.warn("opera-collective-ireland: REST discovery failed:", err);
    return { house_slug: "opera-collective-ireland", productions };
  }

  for (const { slug, title } of catalogue) {
    try {
      const html = await fetchHtml(`${BASE}/production/${slug}/`, ctx);
      const prod = parseEvent(html, slug, stripHtml(title.rendered));
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`opera-collective-ireland: production ${slug} failed:`, err);
    }
  }

  return { house_slug: "opera-collective-ireland", productions };
}

function parseEvent(html: string, slug: string, title: string): RawProduction | null {
  if (!title) return null;
  const composer = composerAfterTitle(html);
  if (!composer) return null;

  const performances = parseDatesAndVenues(html);
  if (performances.length === 0) return null;

  return {
    source_production_id: `opera-collective-ireland/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/production/${slug}/`,
    image_url: ogImage(html),
    performances,
  };
}

const NAME_PARTICLES = new Set(["von", "van", "de", "da", "di", "del", "der", "le", "la", "y"]);

/** The composer is the first text node after the `<h1>` title (before the
 *  date-range span). Usually a bare name ("Handel"); sometimes a byline ("A
 *  Family Opera by Will Todd & Maggie Gottlieb") from which the name after "by"
 *  is taken. Double-bill co-credits ("Purcell | Blow") keep the first name. */
function composerAfterTitle(html: string): string | null {
  const after = html.slice(html.indexOf("</h1>") + 5, html.indexOf("</h1>") + 800);
  for (const chunk of after.split(/<[^>]+>/)) {
    const text = decodeEntities(chunk).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const first = text.split(/\s*(?:\||&|\/| and )\s*/i)[0]?.trim();
    if (first && isPersonName(first)) return first;
    const byName = text.match(/\bby\s+(\p{Lu}[\p{L}’'.-]+(?:\s+\p{Lu}[\p{L}’'.-]+){0,3})/u)?.[1];
    const byFirst = byName?.split(/\s*(?:\||&|\/| and )\s*/i)[0]?.trim();
    if (byFirst && isPersonName(byFirst)) return byFirst;
    // Stop at the first non-empty, non-name node (the date range / blurb).
    if (text.length > 3) return null;
  }
  return null;
}

function isPersonName(text: string): boolean {
  if (
    /^\d/.test(text) ||
    /\b(20\d{2}|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      text,
    )
  ) {
    return false;
  }
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

/** Parse the "Dates & Venues" block into performances. Row-aware: each row is
 *  either "{days} {month}[ YYYY] – {venue}" (touring layout) or, in the upcoming
 *  layout, a `<strong>venue</strong>` followed by `<br>`-separated full dates. One
 *  "{days} {month}[ YYYY]" scan covers both; the venue is the inline text after
 *  the dash, falling back to the nearest `<strong>`/`<a>` venue node. */
function parseDatesAndVenues(html: string): RawPerformance[] {
  const start = html.search(/Dates\s*(?:&amp;|&)\s*Venues/i);
  if (start < 0) return [];
  const end = html.slice(start).search(/\bPress\b|Programme download|programme-download/i);
  const block = html.slice(start, end < 0 ? start + 4000 : start + end);

  const monthYear = buildMonthYearMap(html, block);
  const time = parseTime(stripHtml(block));
  const fallbackVenues = venuePositions(block);

  // Split into rows: the arrow bullets (often entity-encoded) and <br>s are the
  // row separators — decode first so "&#8594;"/"&rarr;" split too, else adjacent
  // date–venue pairs merge and a venue swallows the next date.
  const rows = stripTags(
    decodeEntities(block)
      .replace(/[→➝➔]/g, "\n")
      .replace(/<br\s*\/?>/gi, "\n"),
  ).split("\n");
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  // "{day[, day…]} {Month}[ YYYY]" — covers "25 September 2026" and "4, 5, 7 August".
  const re = /(\d{1,2}(?:\s*,\s*\d{1,2})*)\s+([A-Za-z]+)(?:\s+(20\d{2}))?/g;
  let cursor = 0;
  for (const row of rows) {
    cursor += row.length;
    for (const m of row.matchAll(re)) {
      const month = MONTHS[(m[2] ?? "").toLowerCase()];
      if (!month) continue;
      const year = m[3] ? Number.parseInt(m[3], 10) : (monthYear[month] ?? monthYear.default);
      if (!year) continue;
      const cancelled = /cancel/i.test(row);
      const venue_room =
        inlineVenue(row) ?? nearestVenue(fallbackVenues, cursor / Math.max(1, block.length));
      for (const day of (m[1] ?? "").split(/\s*,\s*/).map((d) => Number.parseInt(d, 10))) {
        if (day < 1 || day > 31) continue;
        const date =
          `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as IsoDate;
        const key = `${date}|${venue_room ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ date, time, venue_room, status: cancelled ? "cancelled" : nightStatus(date) });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** The venue printed inline after the date on a row ("… – Lime Tree Theatre,
 *  Limerick"), trimmed of trailing booking/cancellation noise. */
function inlineVenue(row: string): string | null {
  const after = row.split(/\s[–—-]\s/)[1];
  if (!after) return null;
  // Their rows run several "date – venue" pairs together with only an icon
  // between, so cut the venue at the first thing that starts the next pair: a
  // digit (next date — also clips "Dublin 7" postcodes, acceptable), a pipe
  // separator, or a "Book Now" link.
  const name = after
    .split(/\d|\||book\s*now|cancelled|🕢|🌤️/i)[0]
    ?.replace(/[,\s]+$/, "")
    .trim();
  return name && VENUE_KEYWORD.test(name) ? name : null;
}

/** month → year from the date-range heading + the block, plus a default year. */
function buildMonthYearMap(html: string, block: string): Record<number | "default", number> {
  const text = `${stripHtml(html.slice(0, html.indexOf("Synopsis") + 1 || undefined))} ${stripHtml(block)}`;
  const map: Record<number | "default", number> = { default: 0 };
  for (const m of text.matchAll(/\b([A-Za-z]+)\s+(20\d{2})\b/g)) {
    const month = MONTHS[(m[1] ?? "").toLowerCase()];
    const year = Number.parseInt(m[2] ?? "", 10);
    if (month && year) {
      map[month] ??= year;
      if (!map.default) map.default = year;
    }
  }
  return map;
}

/** Venue-keyword `<strong>`/`<a>` nodes in the block, with their relative
 *  position (0–1) so a date group can pick the nearest one. */
function venuePositions(block: string): { pos: number; name: string }[] {
  const stripped = stripTags(block);
  const out: { pos: number; name: string }[] = [];
  for (const m of block.matchAll(/<(?:strong|a)[^>]*>([\s\S]*?)<\/(?:strong|a)>/g)) {
    const name = stripHtml(m[1] ?? "");
    if (name && VENUE_KEYWORD.test(name)) {
      const before = stripHtml(block.slice(0, m.index ?? 0));
      out.push({ pos: before.length / Math.max(1, stripped.length), name });
    }
  }
  return out;
}

function nearestVenue(venues: { pos: number; name: string }[], pos: number): string | null {
  if (venues.length === 0) return null;
  return venues.reduce((best, v) => (Math.abs(v.pos - pos) < Math.abs(best.pos - pos) ? v : best))
    .name;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
}

/** "7.30pm" → "19:30"; "3pm" → "15:00". First (evening) time on the block. */
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
