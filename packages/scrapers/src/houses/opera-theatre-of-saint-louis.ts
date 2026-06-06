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
 * Opera Theatre of Saint Louis (`spielplan-html` strategy) — the spring opera
 * FESTIVAL in St. Louis, Missouri (US/English; every work sung in English). One
 * edition a year, ~late May–June on the Loretto-Hilton Center stage, dark the
 * rest of the year — so the live scrape is the current (already-announced or
 * just-played) season; `backfill` appends Wikidata for the deep past.
 *
 * WordPress, no JSON-LD and no inline JSON: everything is SSR HTML.
 *   - The `/event-listings/` index links every season item at `/whats-on/{slug}/`.
 *   - Each detail page is one production. The composer is a byline in the opening
 *     `lead-p` paragraph: "By: {composer}", "Music by {composer}", or "Music and
 *     lyrics by {composer}" (an ENGLISH structured byline — NOT the German
 *     composerFromText). The non-opera season items (auditions, "Center Stage"
 *     showcase, art tours, the youth co-production *Joshua's Boots*) carry no
 *     such byline and fail the gate.
 *   - Cast + creative team are `c-col-bio` cards (name `c-col-bio__name`, label
 *     `c-col-bio__role`) under two headings, "Creative Team" then "Cast". Cards
 *     before the "Cast" heading are creative (label = function, mapped in-adapter
 *     via CREATIVE_FUNCTIONS; unmapped specialist labels dropped); cards after it
 *     are sung cast (label = role).
 *   - Performances are `c-instance` rows: `<time class="c-instance__date"
 *     datetime="YYYY-MM-DD">` + `<time class="c-instance__time" datetime="HH:MM">`.
 *
 * Opera filter: REQUIRE a composer byline AND at least one sung cast member. The
 * festival's fixed stage is the Loretto-Hilton Center, so venue is constant.
 */

const BASE = "https://opera-stl.org";
/** Opera Theatre of Saint Louis on Wikidata — the COMPANY/festival. Verified via
 *  wbsearchentities: Q2497917 = "Opera Theatre of Saint Louis", description
 *  "summer opera festival held in St. Louis, Missouri, United States". */
const WIKIDATA_QID = "Q2497917";
const VENUE = "Loretto-Hilton Center";

/** English creative-team labels (the bio card's `c-col-bio__role` text) → our
 *  canonical function slugs. Assistant/apprentice variants fold onto the principal
 *  function. Unmapped specialist labels (Stage Manager, Fight Choreographer,
 *  Intimacy Coordinator, English Diction Specialist, Wig & Makeup Designer,
 *  Repetiteur, combined "Set & Costume Designer") are dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "assistant conductor": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "assistant stage director": "director",
  "apprentice assistant stage director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "stage designer": "set-designer",
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

export async function scrapeOperaTheatreOfSaintLouis(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectProductionSlugs(ctx)) {
      try {
        const prod = parseProduction(
          await fetchHtml(`${BASE}/whats-on/${slug}/`, ctx),
          slug,
          window,
        );
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`opera-theatre-of-saint-louis: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("opera-theatre-of-saint-louis: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opera-theatre-of-saint-louis: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "opera-theatre-of-saint-louis", productions };
}

/** The `/event-listings/` index links every season item at `/whats-on/{slug}/`;
 *  the homepage carries the same set, so it's a cheap fallback if the index moves. */
async function collectProductionSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  for (const path of ["/event-listings/", "/"]) {
    try {
      const html = await fetchHtml(`${BASE}${path}`, ctx);
      for (const [, slug] of html.matchAll(
        /href="https:\/\/opera-stl\.org\/whats-on\/([^"/]+)\/"/g,
      )) {
        if (slug) slugs.add(slug);
      }
    } catch (err) {
      console.warn(`opera-theatre-of-saint-louis: index ${path} failed:`, err);
    }
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const composer = parseComposer(html);
  // No composer byline ⇒ an audition/showcase/tour or the youth co-production,
  // not staged opera. This is the first half of the opera filter.
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(html);
  // A staged opera bills sung roles; the non-opera items that slip past the
  // composer test carry none. This is the second half of the filter.
  if (cast.length === 0) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html) || slugToTitle(slug);
  if (!title) return null;

  return {
    source_production_id: `opera-theatre-of-saint-louis/${slug}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(html),
    detail_url: `${BASE}/whats-on/${slug}/`,
    creative_team,
    cast,
    performances,
  };
}

/** The composer byline is the first `lead-p` paragraph: "By: {name}", "Music by
 *  {name}", or "Music and lyrics by {name}" (a "Book by" credit may precede it
 *  on the musicals). Strip the paragraph's inner markup and read the byline. */
function parseComposer(html: string): string | null {
  const block = html.match(/class="lead-p"[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  if (!block) return null;
  const text = stripHtml(block);
  const m = text.match(/(?:Music and lyrics by|Music by|By:)\s*([^.;]+)/i);
  const composer = m ? (m[1] ?? "").trim() : "";
  return composer && /[A-Za-z]/.test(composer) ? composer : null;
}

function parseTitle(html: string): string | null {
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (og) {
    const title = decodeEntities(og)
      .replace(/\s*[-–|]\s*Opera Theatre of Saint Louis\s*$/i, "")
      .trim();
    if (title) return title;
  }
  return null;
}

/**
 * Cast + creative share the `c-col-bio` card markup; the discriminator is the
 * page's "Cast" heading. Cards before it (under "Creative Team") are creative —
 * the card's `c-col-bio__role` is the function label, mapped via
 * CREATIVE_FUNCTIONS. Cards after it are sung cast — the label is the role.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const castHeading = html.search(/c-col-title[^>]*>\s*Cast\s*<\/h2>/i);
  const split = castHeading === -1 ? html.length : castHeading;

  const creative_team: RawCredit[] = [];
  for (const [, name, label] of bioCards(html.slice(0, split))) {
    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    if (fn) creative_team.push({ function: fn, name });
  }
  dedupe(creative_team, (c) => `${c.function}|${c.name}`);

  const cast: RawCredit[] = [];
  for (const [, name, role] of bioCards(html.slice(split))) {
    if (role) cast.push({ role, name });
  }
  dedupe(cast, (c) => `${c.role}|${c.name}`);

  return { creative_team, cast };
}

/** Yield [match, name, label] for each `c-col-bio` card in a segment. */
function bioCards(segment: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const [, rawName, rawLabel] of segment.matchAll(
    /c-col-bio__name">([^<]*)<\/h5>(?:[\s\S]{0,400}?c-col-bio__role[^>]*>([^<]*)<\/p>)?/g,
  )) {
    const name = stripHtml(rawName ?? "");
    if (!name) continue;
    out.push(["", name, stripHtml(rawLabel ?? "")]);
  }
  return out;
}

function dedupe<T>(rows: T[], key: (row: T) => string): void {
  const seen = new Set<string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const k = key(rows[i] as T);
    if (seen.has(k)) rows.splice(i, 1);
    else seen.add(k);
  }
}

/** Performance rows are `c-instance` blocks: `c-instance__date` (datetime
 *  "YYYY-MM-DD") + an optional `c-instance__time` (datetime "HH:MM"). Tickets are
 *  sold on-site (the availability indicator is rendered out of band), so status
 *  is derived from the date. Every night is on the festival's single stage. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  // Split on the date marker so each night's row is parsed in isolation — the
  // time sits a few hundred chars after the date within the same `c-instance`.
  const segments = html.split(/c-instance__date"\s+datetime="/).slice(1);
  for (const segment of segments) {
    const date = segment.match(/^(\d{4}-\d{2}-\d{2})"/)?.[1];
    if (!date) continue;
    const iso = date as IsoDate;
    if (window.since && iso < window.since) continue;
    const time = segment.match(/c-instance__time"\s+datetime="(\d{1,2}:\d{2})"/)?.[1] ?? null;
    const key = `${iso}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date: iso,
      time,
      venue_room: VENUE,
      status: iso < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** The detail page prints "Performed in English with English captions." Every
 *  OTSL production is sung in English, so this is effectively constant. */
function languageCode(html: string): RawProduction["language"] {
  const first = html.match(/Performed in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
  if (!first) return null;
  return (
    ({
      english: "en",
      italian: "it",
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
    .replace(/-\d{4}$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
