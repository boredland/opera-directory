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
 * Detroit Opera (`json-api` strategy) — a year-round US opera company in Detroit,
 * Michigan (formerly Michigan Opera Theatre; season ~Oct–May at the Detroit Opera
 * House, also presenting dance, films, concerts and galas). The live scrape is the
 * announced + recent seasons; `backfill` appends Wikidata for the deep past.
 *
 * WordPress on WP Engine (Rank Math), with a custom `show` post type exposed at
 * `/wp-json/wp/v2/show`. Every show carries a `show-category` taxonomy term whose
 * slug encodes both the season and the strand (`25-26-opera`, `24-25-dance`,
 * `25-26-special-events`, …). We keep only the `*-opera` terms — that alone drops
 * the dance programmes, films, concerts and special events — and then apply the
 * real opera gate: a parsed composer (see below). The two together also drop the
 * non-staged items that share an opera category (a Cage "concept" evening, a
 * masquerade gala): neither prints a composer.
 *
 * Each show splits across two sources, both keyed by the show id:
 *   - HTML detail page (`/show/{slug}/`) for the bits the REST payload doesn't
 *     resolve: the composer (`<span class="label">Music:</span>` →
 *     `<span class="description">{Name}</span>`, an ENGLISH structured field — NOT
 *     German composerFromText) and the performance rows (`a.single__ticket` whose
 *     text is "Sunday, March 01 2:30 PM"; the row carries no year, so it's taken
 *     from the ACF `hero_data.date_range` and corrected for a Dec→Jan wrap).
 *   - REST `acf.artist_area` for cast + creative team: each entry is a `people`
 *     post id plus a verbatim `production_role` label (the function for creative,
 *     the sung role for cast). Person ids are resolved in one batched `people`
 *     fetch; creative labels are mapped to our slugs in-adapter (CREATIVE_FUNCTIONS).
 *
 * Past shows lose their `a.single__ticket` rows once tickets close, so the deep
 * historical leg comes from Wikidata, not the live pages.
 */

const BASE = "https://detroitopera.org";
const VENUE = "Detroit Opera House";

/** Detroit Opera on Wikidata — the opera COMPANY (Q6837635, "opera company in
 *  Detroit, Michigan, United States, performing in the Detroit Opera House"; it
 *  carries the alias "Michigan Opera Theatre", the company's former name), NOT the
 *  Detroit Opera House building (Q4564213) or the demolished 1869 house
 *  (Q79780854). Verified via wbsearchentities on both "Detroit Opera" and
 *  "Michigan Opera Theatre" — both resolve to Q6837635. */
const WIKIDATA_QID = "Q6837635";

/** English `production_role` labels (ACF `artist_area.creative`) → our canonical
 *  function slugs. Assistant/associate/revival variants fold onto the principal
 *  function; unmapped labels (Wig & Makeup, Sound, Intimacy/Fight Director, …) are
 *  dropped rather than guessed. */
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
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "associate lighting designer": "lighting",
  "projection designer": "projection-designer",
  "associate projection designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "associate choreographer": "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

interface ShowAcf {
  hero_data?: { date_range?: string; sub_head?: string };
  artist_area?: {
    cast?: { cast_artist?: number; production_role?: string }[];
    creative?: { creative_staff?: number; production_role?: string }[];
  };
}
interface ShowPost {
  id: number;
  slug: string;
  title?: { rendered?: string };
  link?: string;
  "show-category"?: number[];
  acf?: ShowAcf;
}
interface PeoplePost {
  id: number;
  title?: { rendered?: string };
}

export async function scrapeDetroitOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const operaCategoryIds = await collectOperaCategoryIds(ctx);
    const shows = await collectOperaShows(ctx, operaCategoryIds);
    const peopleById = await resolvePeople(ctx, shows);

    for (const show of shows) {
      try {
        const prod = await parseProduction(show, peopleById, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`detroit-opera: show ${show.slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("detroit-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("detroit-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "detroit-opera", productions };
}

/** The `show-category` terms whose slug ends in `-opera` (e.g. `25-26-opera`).
 *  Keeping only these is the first, coarse filter that drops the dance/film/
 *  concert/special-event strands. */
async function collectOperaCategoryIds(ctx: FetchContext): Promise<Set<number>> {
  const terms = await fetchJson<{ id: number; slug: string }[]>(
    `${BASE}/wp-json/wp/v2/show-category?per_page=100&_fields=id,slug`,
    ctx,
  );
  return new Set(terms.filter((t) => /-opera$/.test(t.slug)).map((t) => t.id));
}

/** Every `show` post that sits in an opera category. */
async function collectOperaShows(ctx: FetchContext, operaCats: Set<number>): Promise<ShowPost[]> {
  const shows = await fetchJson<ShowPost[]>(
    `${BASE}/wp-json/wp/v2/show?per_page=100&_fields=id,slug,title,link,show-category,acf`,
    ctx,
  );
  return shows.filter((s) => (s["show-category"] ?? []).some((c) => operaCats.has(c)));
}

/** Cast/creative are `people` post ids; resolve them all in one batched fetch
 *  (`include=…`) keyed by id, so each show parse is a pure map lookup. */
async function resolvePeople(ctx: FetchContext, shows: ShowPost[]): Promise<Map<number, string>> {
  const ids = new Set<number>();
  for (const show of shows) {
    for (const c of show.acf?.artist_area?.cast ?? []) if (c.cast_artist) ids.add(c.cast_artist);
    for (const c of show.acf?.artist_area?.creative ?? [])
      if (c.creative_staff) ids.add(c.creative_staff);
  }
  const byId = new Map<number, string>();
  if (ids.size === 0) return byId;

  const all = [...ids];
  for (let i = 0; i < all.length; i += 100) {
    const batch = all.slice(i, i + 100);
    try {
      const people = await fetchJson<PeoplePost[]>(
        `${BASE}/wp-json/wp/v2/people?include=${batch.join(",")}&per_page=100&_fields=id,title`,
        ctx,
      );
      for (const p of people) {
        const name = stripHtml(decodeEntities(p.title?.rendered ?? ""));
        if (name) byId.set(p.id, name);
      }
    } catch (err) {
      console.warn("detroit-opera: people batch failed:", err);
    }
  }
  return byId;
}

async function parseProduction(
  show: ShowPost,
  peopleById: Map<number, string>,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = show.link ?? `${BASE}/show/${show.slug}/`;
  const html = await fetchHtml(detailUrl, ctx);

  const composer = parseComposer(html);
  // No composer ⇒ a non-staged item that shares an opera category (a "concept"
  // evening, a gala). This is the real opera gate, on top of the category filter.
  if (!composer) return null;

  const year = yearFromDateRange(show.acf?.hero_data?.date_range);
  const performances = parsePerformances(html, year, window);
  if (performances.length === 0) return null;

  const title = parseTitle(show, html);
  if (!title) return null;

  const { cast, creative_team } = parseCredits(show.acf?.artist_area, peopleById);

  return {
    source_production_id: `detroit-opera/${show.id}`,
    work_title: title,
    composer_name: composer,
    detail_url: detailUrl,
    cast,
    creative_team,
    performances,
  };
}

/** `<span class="label">Music:</span> <span class="description">{Name}</span>` —
 *  the label casing varies between page templates ("MUSIC:" / "Music:"); a
 *  "Concept:" line (Cage) deliberately does NOT match, so it fails the gate. */
function parseComposer(html: string): string | null {
  const m = html.match(
    /<span class="label">\s*Music:\s*<\/span>\s*<span class="description">([^<]+)<\/span>/i,
  );
  const name = m ? stripHtml(decodeEntities(m[1] ?? "")) : "";
  return name && /[A-Za-z]/.test(name) ? name : null;
}

function parseTitle(show: ShowPost, html: string): string | null {
  const rendered = stripHtml(decodeEntities(show.title?.rendered ?? ""));
  if (rendered) return rendered;
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  return og ? stripHtml(decodeEntities(og)).replace(/\s*[-–|]\s*Detroit Opera\s*$/i, "") : null;
}

/** Cast and creative both live in ACF `artist_area`: a `people` post id plus a
 *  verbatim `production_role` (the function for creative, the sung role for cast).
 *  Creative labels map through CREATIVE_FUNCTIONS (unmapped dropped); cast is kept
 *  verbatim for the resolver. */
function parseCredits(
  area: ShowAcf["artist_area"],
  peopleById: Map<number, string>,
): { cast: RawCredit[]; creative_team: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();

  for (const c of area?.cast ?? []) {
    const name = c.cast_artist ? peopleById.get(c.cast_artist) : undefined;
    const role = (c.production_role ?? "").trim();
    if (!name || !role) continue;
    const key = `r|${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cast.push({ role, name });
  }

  for (const c of area?.creative ?? []) {
    const name = c.creative_staff ? peopleById.get(c.creative_staff) : undefined;
    const fn = CREATIVE_FUNCTIONS[(c.production_role ?? "").trim().toLowerCase()];
    if (!name || !fn) continue;
    const key = `c|${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creative_team.push({ function: fn, name });
  }

  return { cast, creative_team };
}

/** Performance rows are `<a class="single__ticket">…</span>Sunday, March 01 2:30 PM</a>`.
 *  The row text carries no year, so it comes from the ACF `date_range` (which ends
 *  in a 4-digit year); a month earlier than the range's start month is a Dec→Jan
 *  wrap and rolls into the next year. Tickets are sold off-site, so status is
 *  derived from the date (past shows have no rows — Wikidata covers history). */
function parsePerformances(
  html: string,
  range: { year: number; startMonth: number } | null,
  window: ScrapeWindow,
): RawPerformance[] {
  if (!range) return [];
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, monthName, dayStr, timeStr] of html.matchAll(
    /<\/span>\s*[A-Za-z]+day,\s*([A-Za-z]+)\s+(\d{1,2})\s+([\d:]+\s*[AP]M)/gi,
  )) {
    const month = MONTHS[(monthName ?? "").toLowerCase()];
    if (!month) continue;
    const monthNum = Number.parseInt(month, 10);
    const year = monthNum < range.startMonth ? range.year + 1 : range.year;
    const date = `${year}-${month}-${(dayStr ?? "").padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = parseTime(timeStr ?? "");
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time,
      venue_room: VENUE,
      status: date < today ? "past" : "scheduled",
    });
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

/** "March 1-7, 2026" / "December 7-13, 2025" → the year and the range's start
 *  month, which anchor the year-less performance rows. */
function yearFromDateRange(range?: string): { year: number; startMonth: number } | null {
  if (!range) return null;
  const year = range.match(/\b(\d{4})\b/)?.[1];
  const startMonth = MONTHS[range.match(/([A-Za-z]+)/)?.[1]?.toLowerCase() ?? ""];
  if (!year || !startMonth) return null;
  return { year: Number.parseInt(year, 10), startMonth: Number.parseInt(startMonth, 10) };
}

/** "2:30 PM" / "7:30 PM" → 24h "HH:MM". */
function parseTime(text: string): string | null {
  const m = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hour = Number.parseInt(m[1] ?? "", 10);
  const meridian = (m[3] ?? "").toUpperCase();
  if (meridian === "PM" && hour !== 12) hour += 12;
  if (meridian === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}
