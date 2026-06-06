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
 * Boston Lyric Opera (`json-api` strategy) — a year-round US opera company in
 * Boston, Massachusetts (OPERA America). BLO is venue-itinerant: it owns no
 * house and stages each production in a different rented hall (Emerson Colonial
 * Theatre, Symphony Hall, the Opera + Community Studios…), so the venue is
 * captured per production, not as a house constant. The live scrape is the
 * announced season; `backfill` appends Wikidata for the deep past.
 *
 * The site is WordPress running **The Events Calendar** (Tribe), which exposes a
 * clean read-only REST API at `/wp-json/tribe/events/v1/`. Two reads compose a
 * production:
 *   - the **events feed** (`/events`) gives the dated performances — one event
 *     per night, each tagged with the production's own category (`macbeth`,
 *     `vanessa`, `daughter`…) plus cross-cutting tags (the season umbrella, an
 *     "Education" tag, etc.). Grouping by the production category collapses a
 *     run's nights into one production and carries the per-night venue + time.
 *   - the production's **landing page** (`/{category-slug}/`) carries the
 *     composer and the full cast + creative team. Credits are uniform `Name |
 *     Role` modal titles (`<h3 class="modal-title">`); the composer is the
 *     `Music by <strong>…</strong>` line.
 *
 * Opera filter: REQUIRE a composer on the landing page. The feed is dense with
 * non-opera (Street Stage pop-ups, Opera Night/Innovators talks, the Mahler 3 and
 * "Ride of the Valkyries" orchestral concerts, recitals, the staged song-cycle
 * *Song of the Earth*) — none publish a "Music by" line, so they fail the gate.
 *
 * English credit labels are mapped to our canonical function slugs INSIDE this
 * adapter (see CREATIVE_FUNCTIONS); combined labels ("Stage Director/
 * Choreographer") are split and the first mappable part wins. Cloudflare-fronted
 * and unreachable from datacenter IPs, so the house runs with `proxy: true`.
 */

const API = "https://blo.org/wp-json/tribe/events/v1";
const BASE = "https://blo.org";

/** Boston Lyric Opera on Wikidata — the opera COMPANY (Q4947966), verified via
 *  wbsearchentities: "Boston Lyric Opera", description "non-profit organization
 *  in the USA". */
const WIKIDATA_QID = "Q4947966";

/** Window for the live events feed: roughly a year back (so a just-played run's
 *  nights still refresh in the daily incremental) through the full announced
 *  future. The future leg is unbounded by mode; `window.since` clamps the past. */
const FEED_START = "2024-01-01";

/** Categories that are cross-cutting tags, never a single production — they must
 *  not be treated as a production-grouping key. The season umbrella matches a
 *  `\d{4}/\d{2} Season` name pattern and is excluded separately. */
const NON_PRODUCTION_CATEGORIES = new Set([
  "education",
  "teacher-professional-development",
  "childrens-events",
  "ce",
  "street-stage",
  "voices-of-revolution",
  "opera-innovators-series",
  "bpl",
  "workshop",
  "operabox-tv",
]);

/** English credit labels (the modal `Name | Role` function half) → our canonical
 *  function slugs. Combined labels are split on `/` and `,`; the first mappable
 *  part wins. Unmapped labels (Librettist, Wig & Makeup, Intimacy Director, …)
 *  are dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "scenic designer": "set-designer",
  "set designer": "set-designer",
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

interface TribeVenue {
  venue?: string;
}
interface TribeCategory {
  slug?: string;
  name?: string;
}
interface TribeEvent {
  title?: string;
  start_date?: string;
  url?: string;
  venue?: TribeVenue;
  categories?: TribeCategory[];
}
interface TribeEventsResponse {
  events?: TribeEvent[];
  next_rest_url?: string;
}

export async function scrapeBostonLyricOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const groups = groupByProduction(await fetchAllEvents(ctx));
    for (const [slug, events] of groups) {
      try {
        const prod = await buildProduction(slug, events, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`boston-lyric-opera: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("boston-lyric-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("boston-lyric-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "boston-lyric-opera", productions };
}

/** Page through the Tribe events feed from FEED_START forward. */
async function fetchAllEvents(ctx: FetchContext): Promise<TribeEvent[]> {
  const events: TribeEvent[] = [];
  let url: string | null = `${API}/events?per_page=50&start_date=${FEED_START}`;
  for (let page = 0; url && page < 20; page++) {
    const data: TribeEventsResponse = await fetchJson<TribeEventsResponse>(url, ctx);
    if (data.events?.length) events.push(...data.events);
    url = data.next_rest_url ?? null;
  }
  return events;
}

/** Collapse the per-night events into production groups, keyed by the event's
 *  production-specific category. A staged opera carries exactly one such
 *  category (`macbeth`); cross-cutting tags and the season umbrella are skipped.
 *  Events with no production category (one-off pop-ups) drop out here. */
function groupByProduction(events: TribeEvent[]): Map<string, TribeEvent[]> {
  const groups = new Map<string, TribeEvent[]>();
  for (const ev of events) {
    const slug = productionCategory(ev.categories ?? []);
    if (!slug) continue;
    const list = groups.get(slug);
    if (list) list.push(ev);
    else groups.set(slug, [ev]);
  }
  return groups;
}

/** The single production category of an event: a category slug that is neither
 *  the `\d{4}/\d{2} Season` umbrella nor a known cross-cutting tag. */
function productionCategory(categories: TribeCategory[]): string | null {
  for (const c of categories) {
    const slug = c.slug ?? "";
    if (!slug) continue;
    if (NON_PRODUCTION_CATEGORIES.has(slug)) continue;
    if (/^\d{4}-?\d{2}-season$/.test(slug) || /\d{4}\/\d{2}\s*season/i.test(c.name ?? "")) continue;
    return slug;
  }
  return null;
}

async function buildProduction(
  slug: string,
  events: TribeEvent[],
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}/${slug}/`, ctx);

  const composer = parseComposer(html);
  // No "Music by" line ⇒ a concert, recital, talk or staged song-cycle, not
  // staged opera. This is the opera filter.
  if (!composer) return null;

  const performances = parsePerformances(events, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html);
  const title = parseTitle(events) || slugToTitle(slug);
  if (!title) return null;

  return {
    source_production_id: `boston-lyric-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    language: parseLanguage(html),
    detail_url: `${BASE}/${slug}/`,
    creative_team,
    cast,
    performances,
  };
}

/** "Music by <strong>Giuseppe Verdi</strong>" — the value is the first <strong>
 *  after the "Music by" label; a librettist follows in a separate run. */
function parseComposer(html: string): string | null {
  const m = html.match(/Music by\s*(?:<\/span>)?\s*<strong[^>]*>([\s\S]*?)<\/strong>/i);
  const composer = m ? stripHtml(m[1] ?? "") : "";
  return composer && /[A-Za-z]/.test(composer) ? composer : null;
}

/** Every cast member and creative is a `<h3 class="modal-title">Name | Role</h3>`.
 *  A Role that maps to a creative function slug is creative; anything else is a
 *  sung character (cast). */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, raw] of html.matchAll(/<h3 class="modal-title"[^>]*>([\s\S]*?)<\/h3>/g)) {
    const text = stripHtml(raw ?? "");
    const pipe = text.indexOf("|");
    if (pipe < 0) continue;
    const name = decodeEntities(text.slice(0, pipe).trim());
    const label = decodeEntities(text.slice(pipe + 1).trim());
    if (!name || !label) continue;

    const fn = mapFunction(label);
    if (fn === "drop") continue;
    if (fn) {
      const key = `c|${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    } else {
      const key = `r|${label}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role: label, name });
    }
  }
  return { creative_team, cast };
}

/** Recognized production-credit words that are NOT a sung role and NOT a function
 *  we model — a label containing any of these is a creative/staff credit we drop
 *  rather than mis-file as cast (Librettist, Wig & Makeup, Intimacy Director, …). */
const NON_ROLE_LABEL = /\b(librettist|designer|director|dramaturg|coach|master|manager|stage)\b/i;

/** Classify a `Name | Label` credit. Returns a function slug for a mapped creative
 *  label; `null` for a sung role (cast); `"drop"` for a recognized-but-unmodeled
 *  creative/staff label. Combined labels ("Stage Director/Choreographer") are
 *  split on `/` and `,`; the first mappable part wins. */
function mapFunction(label: string): string | "drop" | null {
  for (const part of label.split(/[/,]/)) {
    const fn = CREATIVE_FUNCTIONS[part.trim().toLowerCase()];
    if (fn) return fn;
  }
  return NON_ROLE_LABEL.test(label) ? "drop" : null;
}

/** Performance rows are the production's per-night events; venue + time vary per
 *  night for this itinerant company. Honors window.since; status is past/
 *  scheduled by date. */
function parsePerformances(events: TribeEvent[], window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const ev of events) {
    const m = (ev.start_date ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
    if (!m) continue;
    // Drop non-performance satellites that share a production's category (opening
    // parties, post-show talks) — they carry "Party"/"Talk" in the title.
    if (/\b(party|talk|talkback|reception)\b/i.test(ev.title ?? "")) continue;
    const date = m[1] as IsoDate;
    const time = m[2] ?? null;
    if (window.since && date < window.since) continue;
    const venue = decodeEntities(ev.venue?.venue ?? "").trim() || null;
    const key = `${date}|${time ?? ""}|${venue ?? ""}`;
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

/** The work title is the event title with any " | Boston Lyric Opera" suffix and
 *  parenthetical subtitle stripped (e.g. "Song of the Earth (Das Lied …)"). */
function parseTitle(events: TribeEvent[]): string | null {
  const raw = events.find((e) => e.title)?.title;
  if (!raw) return null;
  const title = decodeEntities(raw)
    .replace(/\s*\|\s*Boston Lyric Opera\s*$/i, "")
    .replace(/\s*[:\-–|]\s*(opening night party|post-show talk).*$/i, "")
    .trim();
  return title || null;
}

const LANGUAGES: Record<string, RawProduction["language"]> = {
  italian: "it",
  english: "en",
  german: "de",
  french: "fr",
  russian: "ru",
  czech: "cs",
  spanish: "es",
};

/** Landing pages print "Performed in English/Italian with English supertitles." */
function parseLanguage(html: string): RawProduction["language"] {
  const first = html.match(/Performed in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
  return (first && LANGUAGES[first]) ?? null;
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
