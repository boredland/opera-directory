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
 * Opera Australia (`spielplan-html` strategy) — Australia's national opera
 * company (AU/English), staging year-round seasons at the Sydney Opera House
 * (Joan Sutherland Theatre), Arts Centre Melbourne / Regent Theatre, plus the
 * outdoor Handa Opera on Sydney Harbour and occasional touring/Canberra dates.
 * The live scrape reads the announced repertoire; `backfill` appends Wikidata
 * for the deep past.
 *
 * WordPress site (Yoast/Kinsta) behind Cloudflare. Each staged work is a
 * `tessi_production` post at `/productions/{slug}/`; the WP REST API is gated
 * (401), so the per-production SSR HTML is the source. The complete production
 * set is enumerated from `tessi_production-sitemap.xml` (the calendar/buy-tickets
 * indexes are JS-rendered). One page yields everything from server-rendered
 * markup, no inline JSON state:
 *   - Cast + creative team in the `.cast-creative-component`: the left column is
 *     the creative team (`<h6 class="role">` an ENGLISH function label, mapped to
 *     our slugs INSIDE this adapter via CREATIVE_FUNCTIONS), the center column is
 *     the cast (`<h6 class="role">` a character name). Each is followed by
 *     `.cast-member` person links.
 *   - composer — the creative column's "Composer" label when present (full name,
 *     contemporary works), else the hero `<h4>` above the title (a surname for
 *     repertory works, e.g. "Verdi"/"Puccini"/"Lehár"). Required (the opera gate),
 *     and the hero fallback rejects co-production / gala taglines that occupy the
 *     same `<h4>` ("…presents", "The reopening of…"). Concerts/galas, musicals
 *     (Phantom, My Fair Lady) and dinners/rehearsals fail the gate — no cast
 *     character roles, no composer, or a different template with no cast block.
 *   - Performances in the `.swiper-slide` carousel: each `<span class="date">`
 *     ("07 Nov 2026") + the ticket button's time ("7:30 pm"), only upcoming
 *     nights (the live page drops past dates — the deep past comes from Wikidata).
 *   - Venue from the `<h6>Venue</h6>` detail row; the slug suffix (`-melbourne`,
 *     `-sydney`, `-brisbane`, `-canberra`, `-on-sydney-harbour`) is the touring
 *     city fallback.
 */

const BASE = "https://opera.org.au";
const SITEMAP_URL = `${BASE}/tessi_production-sitemap.xml`;

/** Opera Australia on Wikidata — the opera COMPANY (Q2916790), not the Sydney
 *  Opera House building (Q45178). Verified via wbsearchentities: Q2916790 =
 *  "Opera Australia", description "principal opera company in Australia". */
const WIKIDATA_QID = "Q2916790";

/** English creative-team labels (the left column's `<h6 class="role">`) → our
 *  canonical function slugs. OA prints original/revival/associate/assistant
 *  variants and unmodeled labels (Sound Designer, Creative Associate, Repetiteur,
 *  English Translation) — folded or dropped here so ingest sees a stable function.
 *  An unmapped label is dropped rather than guessed; cast roles (character names)
 *  live in the separate center column and never hit this map. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "musical director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "director & choreographer": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "set & costume designer": "set-designer",
  "set and costume designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "original lighting designer": "lighting",
  "projection designer": "video-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "assistant choreographer": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeOperaAustralia(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectSlugs(ctx)) {
      try {
        const prod = parseProduction(
          await fetchHtml(`${BASE}/productions/${slug}/`, ctx),
          slug,
          window,
        );
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`opera-australia: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("opera-australia: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opera-australia: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "opera-australia", productions };
}

/** Read the `tessi_production` sitemap's `/productions/{slug}/` entries — the
 *  complete production set (the on-site calendar grid is JS-rendered). */
async function collectSlugs(ctx: FetchContext): Promise<string[]> {
  const xml = await fetchHtml(SITEMAP_URL, ctx);
  const slugs = new Set<string>();
  for (const [, slug] of xml.matchAll(/\/productions\/([^<\s/]+)\//g)) {
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const title = parseTitle(html);
  if (!title) return null;

  const block = castCreativeBlock(html);
  const { creative_team, cast, composerLabel } = parseCredits(block);

  const composer = composerLabel ?? plausibleHeroComposer(html);
  // No composer ⇒ a concert/gala/dinner/musical that isn't a staged opera.
  if (!composer) return null;
  // A staged opera bills sung characters; concerts/galas list singers with no
  // character role. Requiring a named role is the second half of the opera gate.
  if (!cast.some((c) => c.role)) return null;

  const performances = parsePerformances(html, slug, window);
  if (performances.length === 0) return null;

  return {
    source_production_id: `opera-australia/${slug}`,
    work_title: title,
    composer_name: composer,
    language: parseLanguage(html),
    detail_url: `${BASE}/productions/${slug}/`,
    creative_team,
    cast,
    performances,
  };
}

/** Work title from the hero `<h1>` (duplicated for desktop/mobile; first wins). */
function parseTitle(html: string): string | null {
  const m = html.match(/hero__content[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = stripHtml(m?.[1] ?? "");
  return title || null;
}

/** The hero `<h4>` above the title carries the composer surname for repertory
 *  works, but the same slot holds co-production / gala taglines ("…presents",
 *  "The reopening of…") on non-staged shows — rejected here so only a plausible
 *  composer name (short, no sentence/credit phrasing) survives as the fallback. */
function plausibleHeroComposer(html: string): string | null {
  const raw = stripHtml(html.match(/hero__content[\s\S]*?<h4[^>]*>([\s\S]*?)<\/h4>/)?.[1] ?? "");
  if (!raw) return null;
  if (/\b(present|presents|association|reopening|season|gala|concert|in aid)\b/i.test(raw)) {
    return null;
  }
  // A composer name is a handful of capitalized words; taglines run long.
  if (raw.split(/\s+/).length > 4) return null;
  return raw;
}

/** "Performed in Italian with English surtitles." → "it". null when absent. */
function parseLanguage(html: string): RawProduction["language"] {
  const m = html.match(/<h6>\s*Language\s*<\/h6>\s*<div class="contents">\s*<p>([\s\S]*?)<\/p>/);
  if (!m) return null;
  const text = stripHtml(m[1] ?? "");
  const lang = text.match(/\b(?:Performed |Sung )?in ([A-Z][a-z]+)/)?.[1];
  return lang ? (LANGUAGE_CODES[lang.toLowerCase()] ?? null) : null;
}

const LANGUAGE_CODES: Record<string, string> = {
  italian: "it",
  german: "de",
  french: "fr",
  english: "en",
  russian: "ru",
  czech: "cs",
  spanish: "es",
};

/** Isolate the `.cast-creative-component` so its `col-left`/`col-center` markers
 *  don't collide with the page's other layout grids (the synopsis row also uses
 *  `col-left`). Empty string when the production has no cast block (musicals,
 *  dinners, some concerts use a different template). */
function castCreativeBlock(html: string): string {
  const start = html.indexOf("cast-creative-component");
  if (start < 0) return "";
  return html.slice(start, start + 12000);
}

/** Within the block, the left column is the creative team (English function
 *  labels, mapped via CREATIVE_FUNCTIONS) and the center column is the cast
 *  (labels are character names). Entries are `<h6 class="role">label</h6>` then
 *  one or more `.cast-member` links. The creative column's "Composer" label is
 *  surfaced separately as the authoritative composer (full name). */
function parseCredits(block: string): {
  creative_team: RawCredit[];
  cast: RawCredit[];
  composerLabel: string | null;
} {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  let composerLabel: string | null = null;

  const left = columnBlock(block, "col-left");
  const center = columnBlock(block, "col-center");

  const seenCreative = new Set<string>();
  for (const [, label, members] of left.matchAll(ROLE_MEMBER_RE)) {
    const role = stripHtml(label ?? "").toLowerCase();
    for (const name of memberNames(members ?? "")) {
      if ((role === "composer" || role === "music") && !composerLabel) composerLabel = name;
      const fn = CREATIVE_FUNCTIONS[role];
      if (!fn) continue;
      const key = `${fn}|${name}`;
      if (seenCreative.has(key)) continue;
      seenCreative.add(key);
      creative_team.push({ function: fn, name });
    }
  }

  const seenCast = new Set<string>();
  for (const [, label, members] of center.matchAll(ROLE_MEMBER_RE)) {
    const character = stripHtml(label ?? "");
    for (const name of memberNames(members ?? "")) {
      const key = `${character}|${name}`;
      if (seenCast.has(key)) continue;
      seenCast.add(key);
      cast.push({ role: character || null, name });
    }
  }

  return { creative_team, cast, composerLabel };
}

/** A `.cast-member` link can wrap one name; a container may hold several. */
function memberNames(container: string): string[] {
  const names: string[] = [];
  for (const [, name] of container.matchAll(/class="cast-member"[^>]*>([\s\S]*?)<\/a>/g)) {
    const person = stripHtml(name ?? "");
    if (person) names.push(person);
  }
  return names;
}

/** `<h6 class="role">LABEL</h6>` … `<div class="cast-member-container">…</div>`. */
const ROLE_MEMBER_RE =
  /<h6 class="role">([\s\S]*?)<\/h6>\s*<div class="cast-member-container">([\s\S]*?)<\/div>/g;

/** Slice out a single column's contents by its class marker, bounded by the next
 *  column marker so columns don't bleed into one another. */
function columnBlock(block: string, marker: string): string {
  const start = block.indexOf(marker);
  if (start < 0) return "";
  const next = ["col-left", "col-center", "col-right"]
    .map((m) => (m === marker ? -1 : block.indexOf(m, start + marker.length)))
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  return block.slice(start, next ?? block.length);
}

/** Performance nights from the `.swiper-slide` carousel: `<span class="date">`
 *  ("07 Nov 2026") + the ticket button's time + an optional status keyword. The
 *  live page lists only upcoming nights; honors window.since. Venue is the
 *  production's room (fixed across the run). */
function parsePerformances(html: string, slug: string, window: ScrapeWindow): RawPerformance[] {
  const venue = parseVenue(html, slug);
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const slide of html.split('class="swiper-slide"').slice(1)) {
    const date = parseDate(slide.match(/<span class="date">([\s\S]*?)<\/span>/)?.[1] ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;

    const time = parseTime(
      slide.match(/performance-ticket-purchase-btn[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? "",
    );
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date,
      time,
      venue_room: venue,
      status: performanceStatus(slide, date, today),
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Venue from the `<h6>Venue</h6>` detail row (the `<small>` city suffix is
 *  dropped); falls back to the slug's touring-city suffix. */
function parseVenue(html: string, slug: string): string | null {
  const row = html.match(
    /<h6>\s*Venue\s*<\/h6>\s*<div class="contents">\s*<p>([\s\S]*?)<\/p>/,
  )?.[1];
  if (row) {
    const venue = stripHtml(row.replace(/<small>[\s\S]*?<\/small>/g, "")).trim();
    if (venue) return venue;
  }
  return slugCity(slug);
}

/** Touring-city fallback from the slug suffix when no venue row is printed. */
function slugCity(slug: string): string | null {
  if (/on-sydney-harbour/.test(slug)) return "Sydney Harbour";
  if (/-melbourne(\b|-|$)/.test(slug)) return "Melbourne";
  if (/-sydney(\b|-|$)/.test(slug)) return "Sydney";
  if (/-brisbane(\b|-|$)/.test(slug)) return "Brisbane";
  if (/-canberra(\b|-|$)/.test(slug)) return "Canberra";
  return null;
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** "07 Nov 2026" → "2026-11-07". */
function parseDate(text: string): IsoDate | null {
  const m = decodeEntities(text).match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[(m[2] ?? "").toLowerCase()];
  if (!month) return null;
  return isoFromParts(m[3] ?? "", month, m[1] ?? "");
}

/** "7:30 pm" → 24h "19:30"; null when no time is printed. */
function parseTime(text: string): string | null {
  const m = stripHtml(text).match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  let hour = Number.parseInt(m[1] ?? "", 10);
  const meridian = (m[3] ?? "").toLowerCase();
  if (meridian === "pm" && hour !== 12) hour += 12;
  if (meridian === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

function performanceStatus(slide: string, date: IsoDate, today: string): RawPerformance["status"] {
  const kw = stripHtml(slide.match(/class="performance-keywords">([\s\S]*?)<\/div>/)?.[1] ?? "");
  if (/cancel/i.test(kw)) return "cancelled";
  if (/sold\s*out/i.test(kw)) return "sold_out";
  if (/few|selling fast|limited/i.test(kw)) return "few_left";
  return date < today ? "past" : "scheduled";
}
