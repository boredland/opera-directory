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

/**
 * San Diego Opera (`spielplan-html` strategy) — a year-round US opera company
 * (US/English) whose season runs ~Oct–May, mostly on the San Diego Civic Theatre
 * main stage with a chamber/contemporary "detour" series at the smaller Balboa
 * Theatre. The live scrape is the current + announced season; `backfill` appends
 * Wikidata for the deep past.
 *
 * The site is WordPress + Elementor. Page JSON-LD is only LocalBusiness (no
 * Event/cast), so everything comes from the SSR HTML on each `/shows/{slug}/`
 * detail page, which the `/season/` index links:
 *   - composer: the header credit line "<strong>Music by {Name}</strong>"
 *     (or "Music and libretto by {Name}") — an ENGLISH structured field, NOT the
 *     German composerFromText. Required; the opera gate.
 *   - cast + creative: Elementor heading cards pairing an `<h3>` name with the
 *     `<h5>` label below it. A label matching a known creative function (Conductor,
 *     Director, …) maps to creative via CREATIVE_FUNCTIONS (in-adapter); any other
 *     label is the sung character → cast. Per-night cast variants like
 *     "Susannah Polk (Sat)" keep their parenthetical role text.
 *   - performances: Elementor date widgets in one of two `<p>` shapes — Format A
 *     "Friday<br>October 23, 2026<br>7:30pm" (year inline) and Format B
 *     "Friday,<br>July 10<br>at 7:30pm" (year only in the "{Month} D–D, {YYYY}"
 *     range header above). The range header also yields the venue. Tickets are
 *     sold off-site on Tessitura (tickets.sdopera.org), so status is past/scheduled
 *     by date.
 *
 * Opera filter: REQUIRE a composer. Non-opera items (galas/recitals/concerts)
 * publish no "Music by" line and fail this test; staged "detour" operas keep it
 * and pass.
 */

const BASE = "https://www.sdopera.org";
/** San Diego Opera on Wikidata — the opera COMPANY. Verified via wbsearchentities:
 *  Q3354562 = "San Diego Opera", description "opera company located in the city of
 *  San Diego, California". */
const WIKIDATA_QID = "Q3354562";

/** English credit-card labels (`<h5>` under a name) → our canonical function slugs.
 *  Assistant/associate/revival variants fold onto the principal function; a label
 *  that isn't here is treated as a sung character (cast), not dropped. Labels that
 *  ARE creative but unmodeled (Wig/Makeup/Fight Director, etc.) are dropped. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "musical director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "scenery designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeSanDiegoOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectShowSlugs(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}/shows/${slug}/`, ctx), slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`san-diego-opera: show ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("san-diego-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("san-diego-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "san-diego-opera", productions };
}

/** The `/season/` index links every staged production at `/shows/{slug}/`; the
 *  homepage carries the same set, so it's a cheap fallback when the index moves. */
async function collectShowSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  for (const path of ["/season/", "/"]) {
    try {
      const html = await fetchHtml(`${BASE}${path}`, ctx);
      for (const [, slug] of html.matchAll(
        /href="https:\/\/www\.sdopera\.org\/shows\/([^"/]+)\//g,
      )) {
        if (slug) slugs.add(slug);
      }
    } catch (err) {
      console.warn(`san-diego-opera: index ${path} failed:`, err);
    }
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const composer = parseComposer(html);
  // No "Music by" line ⇒ a gala/recital/concert, not staged opera. The opera gate.
  if (!composer) return null;

  const { year, venue } = parseHeader(html);
  const performances = parsePerformances(html, year, venue, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html) || slugToTitle(slug);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `san-diego-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/shows/${slug}/`,
    creative_team,
    cast,
    performances,
  };
}

/** Header credit line: "<strong>Music by {Name}</strong>" or
 *  "<strong>Music and libretto by {Name}</strong>". Value runs to the closing tag. */
function parseComposer(html: string): string | null {
  const m = html.match(/<strong>\s*Music(?:\s+and\s+libretto)?\s+by\s+([^<]+?)\s*<\/strong>/i);
  const composer = m ? stripHtml(m[1] ?? "").trim() : "";
  return composer && /[A-Za-z]/.test(composer) ? composer : null;
}

function parseTitle(html: string): string | null {
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (og) {
    const title = decodeEntities(og.replace(/\s*[|–-]\s*San Diego Opera\s*$/i, "")).trim();
    if (title) return title;
  }
  return null;
}

/** The "{Month} D–D, {YYYY}" range header carries the fallback year (Format B date
 *  cards omit it) and the venue ("San Diego Civic Theatre" / "Balboa Theatre"). */
function parseHeader(html: string): { year: string | null; venue: string | null } {
  const text = stripHtml(html);
  const year = text.match(/[A-Z][a-z]+\s+\d{1,2}\s*[–-]\s*\d{1,2},\s*(\d{4})/)?.[1] ?? null;
  const venue = text.match(/(San Diego Civic Theatre|Balboa Theatre)/)?.[1] ?? null;
  return { year, venue };
}

/**
 * Performance dates live in Elementor date widgets, in two `<p>` shapes:
 *   Format A: "Friday<br>October 23, 2026<br>7:30pm"  (year inline)
 *   Format B: "Friday,<br>July 10<br>at 7:30pm"        (year from the range header)
 * Each `<p>` is reduced to plain text and matched for a "{Month} {Day}[, {Year}]"
 * date plus an "H:MM[ap]m" time. Honors window.since.
 */
function parsePerformances(
  html: string,
  fallbackYear: string | null,
  venue: string | null,
  window: ScrapeWindow,
): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, body] of html.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    const text = stripHtml(body ?? "");
    const dm = text.match(
      /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?/i,
    );
    const tm = text.match(/(\d{1,2}):(\d{2})\s*([ap])m/i);
    if (!dm || !tm) continue;

    const year = dm[3] ?? fallbackYear;
    if (!year) continue;
    const month = MONTHS[(dm[1] ?? "").toLowerCase()];
    if (!month) continue;
    const date = `${year}-${month}-${(dm[2] ?? "").padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;

    const time = parseTime(tm);
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, venue_room: venue, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/** "[7:30, p]" → 24h "HH:MM". */
function parseTime(m: RegExpMatchArray): string | null {
  let hour = Number.parseInt(m[1] ?? "", 10);
  if (Number.isNaN(hour)) return null;
  const meridian = (m[3] ?? "").toLowerCase();
  if (meridian === "p" && hour !== 12) hour += 12;
  if (meridian === "a" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

/**
 * Cast + creative are Elementor heading cards: an `<h3>` name immediately followed
 * by an `<h5>` label. A label in CREATIVE_FUNCTIONS is a creative credit; any other
 * label is the sung character → cast. An `<h3>` with no adjacent `<h5>` (a stray
 * pianist/bio card) is skipped.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenC = new Set<string>();
  const seenR = new Set<string>();

  const headings = [
    ...html.matchAll(/<h([35])[^>]*elementor-heading-title[^>]*>([\s\S]*?)<\/h\1>/g),
  ];
  for (let i = 0; i < headings.length - 1; i++) {
    const cur = headings[i];
    const next = headings[i + 1];
    if (cur?.[1] !== "3" || next?.[1] !== "5") continue;

    const name = stripHtml(cur[2] ?? "");
    const label = stripHtml(next[2] ?? "");
    // Bio/quote h3 cards are long sentences; a real name is short.
    if (!name || !label || name.length > 60) continue;

    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    if (fn) {
      const key = `${fn}|${name}`;
      if (seenC.has(key)) continue;
      seenC.add(key);
      creative_team.push({ function: fn, name });
    } else {
      const key = `${label}|${name}`;
      if (seenR.has(key)) continue;
      seenR.add(key);
      cast.push({ role: label, name });
    }
  }
  return { creative_team, cast };
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
