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
 * Tulsa Opera (`spielplan-html` strategy) — a regional US opera company (Tulsa,
 * Oklahoma; founded 1948) staging a short main season in the Tulsa Performing
 * Arts Center (Chapman Music Hall and the smaller Williams/Liddy Doenges/Williams
 * theatres). US/English. The live scrape reads the current + announced season;
 * `backfill` appends Wikidata for the deep past.
 *
 * WordPress on the Divi theme (Yoast). The page JSON-LD is only Yoast
 * WebPage/BreadcrumbList — no Event/cast — so everything comes from SSR HTML, and
 * the catalogue of production pages is enumerated from the WP REST `pages`
 * endpoint (the `/season/` archive index only lists a few recent seasons).
 * Production pages live one slug under a season at either `/season/{YYYY-YY}-season/{slug}/`
 * (the archive) or `/{YYYY-YY}-season/{slug}/` (the live season); deeper paths
 * (`/digital-program/`, `/artist-bios/`, `/book-club/`, …) are sub-pages and
 * filtered out by the one-segment shape.
 *
 * Per page:
 *   - composer: a "Music by / Music and Libretto by / Composed by {Name}" line in
 *     the intro text box — an ENGLISH structured field (NOT German composerFromText).
 *     REQUIRED; this is the opera filter (recitals, galas, pops and benefit
 *     concerts publish no composer line and drop out).
 *   - title: the Yoast `og:title` ("Aïda - Tulsa Opera"), falling back to the page
 *     `<h1>` then the slug.
 *   - performances: "Weekday, Month D, YYYY at H:MM(am|pm)" lines; status is
 *     past/scheduled by date (single tickets are sold off-site via TPAC/Ticketmaster,
 *     so there is no live availability to read). Venue is the TPAC theatre line.
 *   - cast + creative: the "Meet the Artists" cards — `<h3>{Name}</h3>` immediately
 *     followed by `<p>{Role or Function}</p>`. A function label (Conductor, Director,
 *     …) is mapped in-adapter via CREATIVE_FUNCTIONS → creative team; anything else
 *     is the sung character → cast.
 */

const BASE = "https://tulsaopera.com";
/** Tulsa Opera on Wikidata — the opera COMPANY. Verified via wbsearchentities +
 *  wbgetentities: Q7852342 = "Tulsa Opera", description "non-profit organization
 *  in the USA", P31=Q163740 (nonprofit organization), inception 1948 (P571),
 *  located in Tulsa (P159=Q44989), country USA (P17=Q30), website tulsaopera.com
 *  (P856). The only entity the search returns, and it is the company itself. */
const WIKIDATA_QID = "Q7852342";

/** English function labels (the "Meet the Artists" `<p>` text) → our canonical
 *  function slugs. Revival/associate/assistant variants fold onto the principal
 *  function; an unmapped label means the `<p>` is a sung character name, so the
 *  card is treated as cast instead (see parseCredits). */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
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

export async function scrapeTulsaOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const { path, slug } of await collectProductionPages(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}${path}`, ctx), path, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`tulsa-opera: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("tulsa-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("tulsa-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "tulsa-opera", productions };
}

interface ProductionPage {
  path: string;
  slug: string;
}

/**
 * Enumerate every production page from the WP REST `pages` endpoint. A production
 * is one slug under a season — `/season/{YYYY-YY}-season/{slug}/` (archive) or
 * `/{YYYY-YY}-season/{slug}/` (live). Deeper paths (programs, artist-bios, book
 * clubs) carry more segments and are excluded; the season index pages themselves
 * have no production slug and are excluded too.
 */
async function collectProductionPages(ctx: FetchContext): Promise<ProductionPage[]> {
  const pages = new Map<string, ProductionPage>();
  const shape = /^\/(?:season\/)?(\d{4}-\d{2}-season)\/([^/]+)\/$/;

  for (let page = 1; page <= 5; page++) {
    let batch: { link?: string }[];
    try {
      batch = await fetchJson<{ link?: string }[]>(
        `${BASE}/wp-json/wp/v2/pages?per_page=100&page=${page}&_fields=link`,
        ctx,
      );
    } catch {
      break; // WP returns a 400 past the last page — stop walking.
    }
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const { link } of batch) {
      const path = link?.replace(/^https?:\/\/tulsaopera\.com/, "");
      const m = path?.match(shape);
      if (m) pages.set(path as string, { path: path as string, slug: m[2] as string });
    }
    if (batch.length < 100) break;
  }
  return [...pages.values()];
}

function parseProduction(
  html: string,
  path: string,
  slug: string,
  window: ScrapeWindow,
): RawProduction | null {
  const composer = parseComposer(html);
  // No composer ⇒ a recital/gala/pops/benefit-concert page, not staged opera.
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html) || slugToTitle(slug);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `tulsa-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(path),
    language: languageCode(html),
    detail_url: `${BASE}${path}`,
    creative_team,
    cast,
    performances,
  };
}

/**
 * "Music by / Music and Libretto by / Composed by {Name}". The line must open a
 * heading/paragraph (anchored to a `>` tag boundary) so a mid-prose "music by the
 * honky-tonk band …" in a pops blurb can't pose as a composer. The captured value
 * runs to the next tag/line break and must look like a name (a capitalised word).
 */
function parseComposer(html: string): string | null {
  const m = html.match(
    />\s*(?:Music(?:\s+and\s+Libretto)?\s+by|Composed by|Music:)\s+([^<\r\n]+)/i,
  );
  const composer = m ? stripHtml(decodeEntities(m[1] ?? "")).trim() : "";
  if (!composer || !/^[A-Z]/.test(composer)) return null;
  return composer;
}

/** The Yoast `og:title` ("Aïda - Tulsa Opera") is the cleanest title; fall back to
 *  the page `<h1>` (some layouts drop the title into the heading), then the slug. */
function parseTitle(html: string): string | null {
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (og) {
    const title = decodeEntities(og.replace(/\s*[-–|]\s*Tulsa Opera\s*$/i, "")).trim();
    if (title) return title;
  }
  for (const [, h1] of html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)) {
    const text = stripHtml(h1 ?? "");
    // Some pages put the date line in the h1; reject anything that looks like one.
    if (text && !/\d{4}|\bat\b\s*\d/i.test(text)) return text;
  }
  return null;
}

/**
 * Cast + creative are the "Meet the Artists" cards: `<h3>[<a>]{Name}[</a>]</h3>`
 * immediately followed by `<p>{Role or Function}</p>`. A function label maps to a
 * creative-team slug; any other label is the sung character → cast.
 */
/** A `<p>` label that names a crew/staff function we don't model (so it's neither
 *  a mapped creative slug nor a sung character). Dropped from both lists. */
const CREW_LABEL =
  /\b(?:Designer|Manager|Coach|Master|Mistress|Producer|Supervisor|Coordinator|Assistant|Stylist|Captain|Director|Conductor|Dramaturg|Pianist|Accompanist|Répétiteur|Repetiteur|Wig|Makeup|Make-up|Hair|Props|Crew|Technician|Engineer)\b/i;

function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  // Some cards leave the `<p>` unclosed (`<p>Radamès</div>`), so the label runs to
  // the first closing tag of any kind — not the next `</p>`, which would swallow
  // the following card's name and role.
  for (const [, rawName, rawLabel] of html.matchAll(
    /<h3[^>]*>([\s\S]*?)<\/h3>\s*<p[^>]*>((?:[^<]|<(?!\/(?:p|div|h\d)|h\d))*)/gi,
  )) {
    const name = stripHtml(rawName ?? "");
    const label = stripHtml(rawLabel ?? "");
    if (!name || !label || name.length > 80 || label.length > 60) continue;

    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    if (fn) {
      const key = `c|${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    } else if (CREW_LABEL.test(label)) {
      // An unmapped crew/staff function (Hair/Makeup, Stage Manager, …) — dropped
      // rather than mistaken for a sung character.
    } else {
      const key = `r|${label}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role: label, name });
    }
  }
  return { creative_team, cast };
}

/** Performance lines read "Weekday, Month D, YYYY at H:MM(am|pm)". Tickets are
 *  sold off-site (TPAC/Ticketmaster), so status is derived from the date. Venue is
 *  the page's TPAC theatre line. Honors window.since. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const venue = parseVenue(html);
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, monthName, day, year, hour, minute, meridian] of html.matchAll(
    /([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)/gi,
  )) {
    const month = MONTHS[(monthName ?? "").toLowerCase()];
    if (!month) continue;
    const date = `${year}-${month}-${(day ?? "").padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = to24h(hour ?? "", minute ?? "", meridian ?? "");
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** A named TPAC (or partner) auditorium, optionally suffixed with the building.
 *  Tulsa Opera prints the room on a dedicated line ("Williams Theatre at the Tulsa
 *  Performing Arts Center"); older pages give only "Tulsa Performing Arts Center"
 *  or omit it entirely (→ null). */
const VENUE_ROOM =
  /(Chapman Music Hall|(?:John H\.\s*)?Williams Theatre|Liddy Doenges Theatre|Gussman Concert Hall|VanTrease Performing Arts Center for Education)(?:\s*(?:at the|\|)\s*(Tulsa Performing Arts Center))?/i;

function parseVenue(html: string): string | null {
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, " | ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ");

  const room = text.match(VENUE_ROOM);
  if (room) return [room[1], room[2]].filter(Boolean).join(", ").replace(/\s+/g, " ").trim();
  if (/Tulsa Performing Arts Center/i.test(text)) return "Tulsa Performing Arts Center";
  return null;
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

/** "7:30 pm" → "19:30"; "2:30pm" → "14:30". */
function to24h(hourRaw: string, minute: string, meridianRaw: string): string {
  let hour = Number.parseInt(hourRaw, 10);
  const meridian = meridianRaw.toLowerCase();
  if (meridian === "pm" && hour !== 12) hour += 12;
  if (meridian === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

/** The page prints "Sung in {Language} with … supertitles". */
function languageCode(html: string): RawProduction["language"] {
  const first = html.match(/Sung in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
  if (!first) return null;
  return (
    ({
      italian: "it",
      english: "en",
      german: "de",
      french: "fr",
      russian: "ru",
      czech: "cs",
      spanish: "es",
    }[first] as RawProduction["language"]) ?? null
  );
}

/** "/season/2022-23-season/aida/" → "2022/23". */
function seasonOf(path: string): string | null {
  const m = path.match(/(\d{4})-(\d{2})-season/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/-\d{4}$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
