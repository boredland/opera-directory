import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
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
 * Los Angeles Opera (`jsonld-event` strategy) — Tier-1 US opera company, season
 * ~Sep–Jun in the Dorothy Chandler Pavilion at the Music Center of Los Angeles
 * (US/English). The live scrape is the announced future off laopera.org;
 * `backfill` appends Wikidata for the deep past.
 *
 * The site's `/whats-on` listing and `/whats-on/by-date` are client-rendered, but
 * both the page body AND the nav megamenu hardcode the current `/performances/…`
 * detail links, so one fetch of `/whats-on` enumerates the announced productions
 * without a browser. Two URL shapes appear — `/performances/{year}/{slug}` for the
 * running-season tail and `/performances/{season}/{slug}` (e.g. `2026-27`) for the
 * next, already-announced season.
 *
 * Each detail page is one production and carries everything we need:
 *   - Composer: the centered italic byline "Composed by {X}" or "Music by {X}"
 *     (ENGLISH byline — NOT the German composerFromText). Its presence is also the
 *     opera filter: recitals (Jamie Barton, Renée Fleming) and live-film events
 *     (Hercules vs Vampires) carry no such byline.
 *   - Cast + creative team: artist cards print "<div>{Name}</div><div class=…red…>
 *     {Role-or-Function}</div>". A function in CREATIVE_FUNCTIONS is a team credit
 *     (combined "Director / Scenic Designer" labels are split); any other label is
 *     a sung character role → cast. English labels are mapped INSIDE this adapter.
 *   - Performances: once a production is on sale, one schema.org `Event` JSON-LD
 *     blob per night (`startDate` "YYYY-MM-DDThh:mm:ss", local time). Productions
 *     announced but not yet on sale carry no per-night JSON-LD — for those we fall
 *     back to the hero date-range's start date as a single scheduled performance so
 *     the opera stays visible with a real date.
 * Every performance is in the Dorothy Chandler Pavilion (the company's only stage).
 */

const BASE = "https://www.laopera.org";
const VENUE = "Dorothy Chandler Pavilion";
/** Los Angeles Opera on Wikidata — the opera COMPANY. Verified via
 *  wbsearchentities: Q4992164 = "Los Angeles Opera", description "opera company in
 *  Los Angeles, California". */
const WIKIDATA_QID = "Q4992164";

/** English creative-team labels → our canonical function slugs. Any artist-card
 *  label NOT in this map is treated as a sung character role (cast). Combined
 *  labels ("Director / Scenic Designer", "Scenic and Costume Designer") are split
 *  on "/" and " and " before lookup so each half maps independently. */
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
  // Bare design nouns cover the shared-head combined card "Scenic and Costume
  // Designer", which splits into "Scenic" + "Costume Designer".
  scenic: "set-designer",
  costume: "costume-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "original lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  "animation designer": "projection-designer",
  choreographer: "choreographer",
  "chorus director": "chorus-master",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeLosAngelesOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const path of await collectProductionPaths(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}${path}`, ctx), path, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`los-angeles-opera: production ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("los-angeles-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("los-angeles-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "los-angeles-opera", productions };
}

/** The `/whats-on` page (body cards + nav megamenu) hardcodes the current
 *  `/performances/{season}/{slug}` detail links. Collect the unique set. */
async function collectProductionPaths(ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(`${BASE}/whats-on`, ctx);
  const paths = new Set<string>();
  for (const [, path] of html.matchAll(/href="(\/performances\/[^"]+\/[^"/]+)"/g)) {
    if (path) paths.add(path);
  }
  return [...paths];
}

function parseProduction(html: string, path: string, window: ScrapeWindow): RawProduction | null {
  const composer = composerByline(html);
  // No "Composed by" / "Music by" byline ⇒ a recital or live-film event, not staged opera.
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(html);
  // A staged opera bills sung character roles; recitals/film events that slip past
  // the byline test carry none. This is the opera filter.
  if (cast.length === 0) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "") || slugTitle(path);
  if (!title) return null;

  return {
    source_production_id: `los-angeles-opera${path}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}${path}`,
    creative_team,
    cast,
    performances,
  };
}

/** Composer is the centered italic byline "Composed by {X}" or "Music by {X}".
 *  Stop at the first sentence boundary (a "Music by …. Book by …" lead-in). */
function composerByline(html: string): string | null {
  for (const m of html.matchAll(/<p class="italic">([\s\S]*?)<\/p>/g)) {
    const text = stripHtml(m[1] ?? "");
    const byline = text.match(/^(?:Composed by|Music by)\s+([^.,;]+)/i)?.[1]?.trim();
    if (byline && /[A-Za-z]/.test(byline)) return byline;
  }
  return null;
}

/**
 * Artist cards print "<div class='font-bold text-lg …'>{Name}</div>" immediately
 * followed by "<div class='uppercase text-sm text-red font-bold'>{label}</div>".
 * A label in CREATIVE_FUNCTIONS is a production-team credit; anything else is a
 * sung character role → cast.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, name, label] of html.matchAll(
    /font-bold text-lg[^"]*">([^<]*)<\/div>\s*<div class="uppercase text-sm text-red font-bold">([^<]*)<\/div>/g,
  )) {
    const cleanName = stripHtml(name ?? "");
    const cleanLabel = stripHtml(label ?? "");
    if (!cleanName || !cleanLabel) continue;

    const functions = mappedFunctions(cleanLabel);
    if (functions.length > 0) {
      for (const fn of functions) {
        const key = `team|${fn}|${cleanName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        creative_team.push({ function: fn, name: cleanName });
      }
    } else {
      const key = `cast|${cleanLabel}|${cleanName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role: cleanLabel, name: cleanName });
    }
  }
  return { creative_team, cast };
}

/** Map a (possibly combined) team label to function slugs. A combined card like
 *  "Director / Scenic Designer" splits into both; returns [] for sung roles. */
function mappedFunctions(label: string): string[] {
  const out: string[] = [];
  for (const part of label.split(/\s*\/\s*|\s+and\s+/i)) {
    const fn = CREATIVE_FUNCTIONS[part.trim().toLowerCase()];
    if (fn && !out.includes(fn)) out.push(fn);
  }
  return out;
}

/** Per-night dates come from schema.org `Event` JSON-LD (one per night, local-time
 *  `startDate`). Productions not yet on sale carry no JSON-LD — fall back to the
 *  hero date-range's start date as a single scheduled performance. Honors
 *  window.since. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const node of eventNodes(html)) {
    const start = typeof node.startDate === "string" ? node.startDate : "";
    const m = start.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
    if (!m) continue;
    const date = m[1] as IsoDate;
    if (window.since && date < window.since) continue;
    const time = m[2] ?? null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time,
      venue_room: VENUE,
      status: cancelled(node) ? "cancelled" : date < today ? "past" : "scheduled",
    });
  }

  if (out.length === 0) {
    const opening = heroOpeningDate(html);
    if (opening && (!window.since || opening >= window.since)) {
      out.push({
        date: opening,
        time: null,
        venue_room: VENUE,
        status: opening < today ? "past" : "scheduled",
      });
    }
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Pull `Event` nodes from the page's JSON-LD scripts. */
function eventNodes(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse((m[1] ?? "").trim());
    } catch {
      continue;
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (
        node &&
        typeof node === "object" &&
        (node as Record<string, unknown>)["@type"] === "Event"
      )
        out.push(node as Record<string, unknown>);
    }
  }
  return out;
}

/** The hero shows a date range "Oct 17 - Nov 7, 2026" / "May 30 - Jun 21, 2026";
 *  parse its opening date (the trailing year applies to both ends). Used only when
 *  no per-night JSON-LD exists yet. */
function heroOpeningDate(html: string): IsoDate | null {
  const m = stripHtml(html).match(
    /\b([A-Z][a-z]{2})[a-z]*\s+(\d{1,2})\s*[–-]\s*[A-Z][a-z]{2}[a-z]*\s+\d{1,2},\s*(\d{4})/,
  );
  const month = m ? MONTHS[m[1]?.toLowerCase() ?? ""] : undefined;
  if (!m || !month) return null;
  return isoFromParts(m[3] ?? "", month, m[2] ?? "");
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

function cancelled(node: Record<string, unknown>): boolean {
  return typeof node.eventStatus === "string" && /Cancelled/i.test(node.eventStatus);
}

function slugTitle(path: string): string {
  return (path.split("/").pop() ?? "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
