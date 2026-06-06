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
 * Arizona Opera (`spielplan-html` strategy) — a Tier-1 US opera company
 * (US/English) playing a year-round season to TWO cities: every production runs
 * first in Phoenix (Symphony Hall) and then in Tucson (Tucson Music Hall), so a
 * single production's performances split across both venues. Ticketing is
 * Tessitura (tickets.azopera.org), but that host exposes no public TNEW/REST
 * production API (301/404) — all production metadata lives on the Drupal 7
 * marketing site, which is what this adapter reads. The live scrape walks the
 * site's production pages; `backfill` appends Wikidata for the deep past.
 *
 * No JSON-LD / `__NEXT_DATA__` — plain SSR HTML. The complete production set is
 * the sitemap's `/performances/{slug}` entries (the `/performances` index only
 * lists the running + next season). Each production splits over two pages:
 *   - `/performances/{slug}` — the `field-sub-title` pane prints the composer as
 *     free text ("Music by Giuseppe Verdi, …", "An Opera by …", "By …"); the
 *     `showtime-group` blocks carry the dated performances, grouped under an
 *     `<h3>City</h3>` (Phoenix / Tucson), each a `date-display-single` span whose
 *     `content` attribute is a local-time ISO string; the body pane prints the
 *     sung language.
 *   - `/performances/{slug}/cast` — `cast-row` tables list cast + creative
 *     uniformly: an `<h2>` name plus a trailing role label. A label of "Composer"
 *     is the composer (a fallback when the sub-title pane is blank, e.g. older
 *     seasons); a known creative function maps via CREATIVE_FUNCTIONS; anything
 *     else is treated as a sung role (cast).
 *
 * Opera filter: REQUIRE a composer (from the sub-title pane OR a "Composer"
 * cast-row). Recitals, cabarets and concerts (e.g. Jamie Barton Recital, Studio
 * Cabaret) print neither and drop out — the opera gate. Each production keeps its
 * Phoenix/Tucson split via per-performance `venue_room`.
 */

const BASE = "https://www.azopera.org";
const SITEMAP_URL = `${BASE}/sitemap.xml`;

/** Arizona Opera on Wikidata — the opera COMPANY (Q4791363), not the orchestra
 *  musicians' association (Q4791364). Verified via wbsearchentities: Q4791363 =
 *  "Arizona Opera", description "opera company in the USA". */
const WIKIDATA_QID = "Q4791363";

/** The two touring cities → the venue each plays. The production page groups
 *  performances under a bare `<h3>` city name; the hall is constant per city. */
const CITY_VENUES: Record<string, string> = {
  phoenix: "Phoenix Symphony Hall",
  tucson: "Tucson Music Hall",
};

/** English `cast-row` role labels → our canonical function slugs. Assistant /
 *  associate / revival variants fold onto the principal function; a combined
 *  "Stage Director & Choreographer" maps to director (its choreographer half is
 *  dropped rather than duplicated). An unmapped label is treated as a sung role,
 *  not guessed into the creative team. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "musical director": "conductor",
  "pianist / musical director": "conductor",
  director: "director",
  "stage director": "director",
  "stage director & choreographer": "director",
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

export async function scrapeArizonaOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectSlugs(ctx)) {
      try {
        const prod = await parseProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`arizona-opera: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("arizona-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("arizona-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "arizona-opera", productions };
}

/** Read the sitemap's `/performances/{slug}` entries — the complete production
 *  set (the live `/performances` index only lists the current + next season).
 *  The `/cast` sub-pages share the prefix and are excluded. */
async function collectSlugs(ctx: FetchContext): Promise<string[]> {
  const xml = await fetchHtml(SITEMAP_URL, ctx);
  const slugs = new Set<string>();
  for (const [, slug] of xml.matchAll(
    /<loc>https:\/\/www\.azopera\.org\/performances\/([^<\s/]+)<\/loc>/g,
  )) {
    if (slug) slugs.add(decodeURIComponent(slug));
  }
  return [...slugs];
}

async function parseProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const encoded = encodeURIComponent(slug);
  const main = await fetchHtml(`${BASE}/performances/${encoded}`, ctx);

  const performances = parsePerformances(main, window);
  if (performances.length === 0) return null;

  const castHtml = await fetchHtml(`${BASE}/performances/${encoded}/cast`, ctx).catch(() => "");
  const { creative_team, cast, castComposer } = parseCredits(castHtml);

  // No composer ⇒ a recital / cabaret / concert, not staged opera. The sub-title
  // pane is the primary source; the "Composer" cast-row is the older-season fallback.
  const composer = parseComposer(main) ?? castComposer;
  if (!composer) return null;

  const title = parseTitle(main) || slugToTitle(slug);
  if (!title) return null;

  return {
    source_production_id: `arizona-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(main),
    detail_url: `${BASE}/performances/${slug}`,
    creative_team,
    cast,
    performances,
  };
}

/** The `field-sub-title` pane prints the composer as free text. Strip the
 *  leading credit phrase ("Music by", "Music and libretto by", "An Opera by",
 *  "By") and keep the name up to the first librettist clause. */
function parseComposer(html: string): string | null {
  const pane = html.match(
    /views-field-field-sub-title[\s\S]*?<div class="field-content">([\s\S]*?)<\/div>/,
  )?.[1];
  if (!pane) return null;

  const text = stripHtml(pane);
  const m = text.match(/^\s*(?:music and libretto by|music by|an opera by|by)\s+(.+)$/i);
  const raw = m ? (m[1] ?? "") : "";
  // Drop a trailing librettist clause ("…, Libretto by …" / "… and libretto by …").
  const composer = raw
    .replace(/[,;]?\s*(?:and\s+)?libretto by[\s\S]*$/i, "")
    .replace(/[,;]\s*$/, "")
    .trim();
  return composer && /[A-Za-z]/.test(composer) ? composer : null;
}

function parseTitle(html: string): string | null {
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (og) {
    const title = decodeEntities(og)
      .replace(/\s*[-–|]\s*Arizona Opera\s*$/i, "")
      .trim();
    if (title) return title;
  }
  const t = html.match(/<title>([^<]*)<\/title>/i)?.[1];
  if (t) {
    const title = decodeEntities(t)
      .replace(/\s*\|\s*Arizona Opera\s*$/i, "")
      .trim();
    if (title) return title;
  }
  return null;
}

/**
 * Cast + creative share the `cast-row` table markup: an `<h2>` name (usually an
 * `<a>` to the artist page) followed by a trailing role label, then a
 * `cast-dates` span. The label discriminates: "Composer" → the composer (gate
 * fallback); a known function → creative team; anything else → a sung role (cast).
 */
function parseCredits(html: string): {
  creative_team: RawCredit[];
  cast: RawCredit[];
  castComposer: string | null;
} {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  let castComposer: string | null = null;
  const seen = new Set<string>();

  for (const [, body] of html.matchAll(
    /cast-row">([\s\S]*?)(?=views-row views-row-\d|<div class="panel-separator")/g,
  )) {
    const name = stripHtml(
      (body ?? "").match(/<h2>(?:<a[^>]*>)?([\s\S]*?)(?:<\/a>)?<\/h2>/)?.[1] ?? "",
    );
    if (!name) continue;

    const label = stripHtml(
      (body ?? "").match(/<\/h2>([\s\S]*?)<span class="cast-dates"/)?.[1] ?? "",
    );
    const fnKey = label.toLowerCase();

    if (fnKey === "composer") {
      castComposer ??= name;
      continue;
    }

    const fn = CREATIVE_FUNCTIONS[fnKey];
    if (fn) {
      const key = `c|${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    } else {
      const role = label || null;
      const key = `r|${role ?? ""}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role, name });
    }
  }
  return { creative_team, cast, castComposer };
}

/**
 * Performance nights live in `showtime-group` blocks, each headed by an
 * `<h3>City</h3>` (Phoenix / Tucson) and listing `date-display-single` spans
 * whose `content` attribute is a local-time ISO string. The venue is fixed per
 * city. A "cancelled-" slug prefix or in-row "cancelled" text marks a scrapped
 * run; otherwise status is date-derived. Honors window.since.
 */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  // Scope to the Showtimes pane (from its marker to the next pane) so stray
  // `<h3>` headings elsewhere on the page (e.g. "Featured") can't be mistaken
  // for a city group.
  const start = html.indexOf("performance-showtimes");
  if (start < 0) return out;
  const rest = html.slice(start);
  const end = rest.indexOf("panel-separator");
  const pane = end >= 0 ? rest.slice(0, end) : rest;

  for (const [, city, block] of pane.matchAll(
    /<h3>([^<]+)<\/h3>([\s\S]*?)(?=<div class="showtime-group">|$)/g,
  )) {
    const cityName = stripHtml(city ?? "");
    const venue = CITY_VENUES[cityName.toLowerCase()] ?? cityName;

    for (const [, iso, visible] of (block ?? "").matchAll(
      /content="([^"]+)"[^>]*class="date-display-single">([\s\S]*?)<\/span>/g,
    )) {
      const m = (iso ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
      if (!m) continue;
      const date = m[1] as IsoDate;
      const time = m[2] ?? null;
      if (window.since && date < window.since) continue;

      const key = `${date}|${time ?? ""}|${venue}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const cancelled = /cancel/i.test(visible ?? "");
      out.push({
        date,
        time,
        venue_room: venue,
        status: cancelled ? "cancelled" : date < today ? "past" : "scheduled",
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time ?? "").localeCompare(b.time ?? "") ||
      (a.venue_room ?? "").localeCompare(b.venue_room ?? ""),
  );
}

/** The body pane prints "Performed in Italian with English and Spanish supertitles." */
function languageCode(html: string): RawProduction["language"] {
  const first = html.match(/Performed in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
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

function slugToTitle(slug: string): string {
  return slug
    .replace(/^cancelled-/, "")
    .replace(/-\d+$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
