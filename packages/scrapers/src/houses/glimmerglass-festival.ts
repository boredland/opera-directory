import type { IsoDate } from "@opera-directory/schema";
import { extractEventJsonLd, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * The Glimmerglass Festival (`jsonld-event` strategy) — the US summer opera
 * festival in Cooperstown, New York (~July–August), staged in the Alice Busch
 * Opera Theater. A FESTIVAL: one edition at a time → the live scrape is the
 * CURRENT season's staged opera; `backfill` appends Wikidata.
 *
 * Glimmerglass deliberately programs opera AND a Broadway-style musical each
 * summer (here *Oklahoma!*, *Happy End*) plus recitals/galas/dinners — so the
 * adapter FILTERS to opera and drops the rest.
 *
 * WordPress (Yoast). Two cheap sources, no browser needed:
 *   - The festival hub `/festivals/{year}-festival/` links to `/events/{slug}/`.
 *   - Each event page carries one schema.org `Event` JSON-LD whose `subEvent[]`
 *     is the per-night performance list (`startDate` = ISO date+time, `location`
 *     = the theater). `extractEventJsonLd()` pulls it. The JSON-LD has NO
 *     composer/cast, so those come from the page's centered credit paragraph:
 *       "Music by {Composer}<br>Libretto by …<br>Conductor | {Name}<br>…"
 *     The composer is the ENGLISH "Music by" byline (NOT German composerFromText);
 *     credit labels are "{Label} | {Name}" pairs, mapped to our function slugs
 *     INSIDE this adapter. No per-role cast is published → cast stays empty.
 *
 * Opera filter (separates opera from the musical/recital titles): require the
 * "Music by …" byline (a musical reads "Music and lyrics by …"), a "Libretto"
 * credit (musicals carry "Book by"/"Lyrics by" instead), and a Conductor — the
 * combination that *Oklahoma!*, *Happy End*, the Winterreise recital and the
 * Ellis Island song-vignettes all fail while every staged opera passes.
 */

const BASE = "https://glimmerglass.org";
/** Glimmerglass Festival on Wikidata. Verified via wbsearchentities:
 *  Q5569634 = "Glimmerglass Festival", description "opera festival held in
 *  Cooperstown, New York, United States" (alias "Glimmerglass Opera"). */
const WIKIDATA_QID = "Q5569634";

/** English creative-team labels (as printed "{Label} | {Name}") → our function
 *  slugs. Glimmerglass prints production/revival-director variants — folded here
 *  so ingest sees a stable function. Unmapped labels are dropped (no cast list). */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "original production director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "scenic designer": "set-designer",
  "set designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  choreographer: "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeGlimmerglassFestival(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectEventSlugs(ctx)) {
      try {
        const prod = parseEvent(await fetchHtml(`${BASE}/events/${slug}/`, ctx), slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`glimmerglass-festival: event ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("glimmerglass-festival: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("glimmerglass-festival: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "glimmerglass-festival", productions };
}

/** Hub `/events/{slug}/` links that are ancillary social events, not staged shows:
 *  dinners, brunches, film nights, the after-hours cabaret, the sendoff picnic.
 *  They'd fail the opera filter anyway, but their pages respond pathologically
 *  slowly (each burns the full per-request timeout), so skip them before fetching. */
const ANCILLARY_SLUG = /dinner|brunch|flick|after-hours|picnic|gala|preview|sendoff/i;

/** Find the current festival hub (this/next year) and collect its staged-show
 *  `/events/{slug}/` links (ancillary social events filtered out up front). The
 *  remaining musical/recital titles still fall to the opera filter downstream. */
async function collectEventSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  const year = new Date().getFullYear();
  for (const y of [year, year + 1]) {
    try {
      const html = await fetchHtml(`${BASE}/festivals/${y}-festival/`, ctx);
      for (const [, slug] of html.matchAll(
        /href="https:\/\/glimmerglass\.org\/events\/([^"/]+)\/"/g,
      )) {
        if (slug && !ANCILLARY_SLUG.test(slug)) slugs.add(slug);
      }
    } catch {
      // A future edition's hub may not exist yet — non-fatal.
    }
  }
  return [...slugs];
}

function parseEvent(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const composer = composerFromByline(html);
  if (!composer) return null;

  const { creative_team, hasLibretto } = parseCredits(html);
  // The opera/musical discriminator: a staged opera bills a Libretto AND a
  // Conductor (musicals carry "Book by"/"Lyrics by" and skip one of these).
  if (!hasLibretto) return null;
  if (!creative_team.some((c) => c.function === "conductor")) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title =
    stripHtml(html.match(/<h1 class="event-title">([\s\S]*?)<\/h1>/)?.[1] ?? "") ||
    slugToTitle(slug);
  if (!title) return null;

  return {
    source_production_id: `glimmerglass/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/events/${slug}/`,
    creative_team,
    cast: [],
    performances,
  };
}

/** The composer is the "Music by {Composer}" byline. A musical reads "Music and
 *  lyrics by …" — reject those so they fail the opera filter here. */
function composerFromByline(html: string): string | null {
  const m = html.match(/Music\s+(and\s+lyrics\s+)?by\s+([^<&]+)/i);
  if (!m || m[1]) return null;
  const composer = (m[2] ?? "").trim();
  return composer && /[A-Za-z]/.test(composer) ? composer : null;
}

/** Credits are centered "{Label} | {Name}" lines joined by <br>; "Libretto by …"
 *  is a non-credit byline we only test for. Returns mapped creative team + the
 *  libretto flag used by the opera filter. */
function parseCredits(html: string): { creative_team: RawCredit[]; hasLibretto: boolean } {
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();

  for (const block of html.matchAll(/<p[^>]*text-align:\s*center[^>]*>([\s\S]*?)<\/p>/gi)) {
    for (const line of (block[1] ?? "").split(/<br\s*\/?>/i)) {
      const [labelPart, namePart] = line.split("|");
      if (namePart === undefined) continue;
      const label = stripHtml(labelPart ?? "").toLowerCase();
      const fn = CREATIVE_FUNCTIONS[label];
      if (!fn) continue;
      for (const name of splitNames(namePart)) {
        const key = `${fn}|${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        creative_team.push({ function: fn, name });
      }
    }
  }
  return { creative_team, hasLibretto: /Libretto\s+by/i.test(html) };
}

/** One credit line may list co-credits joined by "and"/"&"/"/". */
function splitNames(raw: string): string[] {
  return stripHtml(raw)
    .split(/\s*(?:&|\/|\band\b)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);
}

/** Performances come from the Event JSON-LD `subEvent[]` (each `startDate` is an
 *  ISO date+time, `location.name` the theater). Honors window.since. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  const today = new Date().toISOString().slice(0, 10);

  for (const event of extractEventJsonLd(html)) {
    const subs = Array.isArray(event.subEvent) ? event.subEvent : [];
    for (const sub of subs) {
      if (!sub || typeof sub !== "object") continue;
      const node = sub as Record<string, unknown>;
      const start = typeof node.startDate === "string" ? node.startDate : "";
      const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(start);
      if (!match) continue;
      const date = match[1] as IsoDate;
      if (window.since && date < window.since) continue;
      const time = match[2] ?? null;
      const key = `${date}|${time ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        date,
        time,
        venue_room: venueName(node) ?? venueName(event),
        status: cancelled(node) ? "cancelled" : date < today ? "past" : "scheduled",
      });
    }
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

function venueName(node: Record<string, unknown>): string | null {
  const loc = node.location;
  if (loc && typeof loc === "object") {
    const name = (loc as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name.replace(/\s*\(.*\)\s*$/, "").trim();
  }
  return null;
}

function cancelled(node: Record<string, unknown>): boolean {
  return typeof node.eventStatus === "string" && /Cancelled/i.test(node.eventStatus);
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
