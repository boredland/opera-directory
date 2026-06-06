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
 * The Dallas Opera (`jsonld-event` strategy) — the Tier-1 US opera company in
 * Dallas, Texas (US/English), mainstage season ~Oct–Apr in the Winspear Opera
 * House. `backfill` appends Wikidata (currently empty for this house — kept for
 * forward compatibility as Wikidata's WikiProject Performing Arts fills in).
 *
 * WordPress (Yoast) site. The season's stagings are `/performance/{slug}/`
 * pages, linked from the mainstage season index. Each detail page carries one
 * schema.org `MusicEvent` JSON-LD that is the ONLY reliably server-rendered
 * source on the page:
 *   - `name` (work title), `location.name` (Winspear Opera House), `eventStatus`.
 *   - `startDate` + `endDate` as local-time ISO ("YYYY-MM-DDThh:mm:ss-06:00") —
 *     the run's opening and closing nights. The site does NOT statically expose
 *     the intermediate nights (the per-night ticket grid + the cast/creative
 *     tab are injected client-side by the shared "dams-ao-core" widget, and load
 *     inconsistently even under a headless render), so we faithfully emit only
 *     the two anchor nights the JSON-LD asserts rather than fabricate the rest.
 *   - The composer is the ENGLISH byline inside the JSON-LD `description`
 *     ("… star in {Composer}'s {TITLE}, {dates}, at The Dallas Opera.") — NOT the
 *     German composerFromText.
 * Cast + creative team are parsed from `.cast-person` cards when the page happens
 * to have rendered them server-side (often absent → empty arrays). English
 * function labels are mapped INSIDE this adapter (see CREATIVE_FUNCTIONS).
 *
 * Opera filter: a real staging has a MusicEvent JSON-LD with a composer byline.
 * Concerts/recitals/family shows live under other paths and lack the byline.
 *
 * No reusable Tessitura JSON API here — the house is WordPress + a client-side
 * "dams-ao-core" content widget, not a Tessitura TNEW/REST front end.
 */

const BASE = "https://dallasopera.org";
const SEASON_INDEX = `${BASE}/seasons/mainstage/`;
/** The Dallas Opera on Wikidata — the opera COMPANY. Verified via
 *  wbsearchentities: Q3354550 = "Dallas Opera", description "non-profit
 *  organization in Texas, US"; wbgetentities confirms P31 = Q215380 (musical
 *  ensemble) + Q163740 (nonprofit), P159 = Q16557 (Dallas), founded 1957,
 *  official site dallasopera.org. */
const WIKIDATA_QID = "Q3354550";

/** English creative-team labels (as printed in `.cast-person .role`) → our
 *  canonical function slugs. Any role card whose label is NOT in this map is
 *  dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  production: "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "scenic designer": "set-designer",
  "set designer": "set-designer",
  "set and projection designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus director": "chorus-master",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeDallasOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectPerformanceSlugs(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}/performance/${slug}/`, ctx), slug);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`dallas-opera: performance ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("dallas-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("dallas-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "dallas-opera", productions };
}

/** Walk the mainstage season index (and the homepage as a fallback) and collect
 *  unique `/performance/{slug}/` slugs for the announced season. */
async function collectPerformanceSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  for (const url of [SEASON_INDEX, `${BASE}/`]) {
    try {
      const html = await fetchHtml(url, ctx);
      for (const [, slug] of html.matchAll(
        /href="https:\/\/dallasopera\.org\/performance\/([^"/]+)\/"/g,
      )) {
        if (slug) slugs.add(slug);
      }
    } catch (err) {
      console.warn(`dallas-opera: index ${url} failed:`, err);
    }
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string): RawProduction | null {
  const event = musicEvent(html);
  if (!event) return null;

  const composer = composerFromByline(
    typeof event.description === "string" ? event.description : "",
  );
  // No "{Composer}'s {TITLE}" byline ⇒ not a staged mainstage opera.
  if (!composer) return null;

  const performances = parsePerformances(event);
  if (performances.length === 0) return null;

  const title =
    (typeof event.name === "string" && stripHtml(event.name)) ||
    stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "") ||
    slugToTitle(slug);
  if (!title) return null;

  const { cast, creative_team } = parseCredits(html);

  return {
    source_production_id: `dallas-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/performance/${slug}/`,
    creative_team,
    cast,
    performances,
  };
}

/** The page's schema.org `MusicEvent` (or any Event subtype) JSON-LD node. */
function musicEvent(html: string): Record<string, unknown> | null {
  for (const node of extractEventJsonLd(html)) {
    if (typeof node.startDate === "string") return node;
  }
  return null;
}

/** Composer is the ENGLISH byline in the JSON-LD description:
 *  "… star(s) in {Composer}'s {TITLE}, {dates}, at The Dallas Opera." */
function composerFromByline(description: string): string | null {
  const m = description.match(/\bin\s+(\p{Lu}[\p{L}.'’\- ]*?)['’]s\s+\p{Lu}/u);
  const composer = m?.[1]?.trim();
  return composer && /[A-Za-z]/.test(composer) ? composer : null;
}

/** The JSON-LD asserts the run's opening (`startDate`) and closing (`endDate`)
 *  nights; emit both (deduped) at the Winspear. The site doesn't statically
 *  publish the intermediate nights, so we don't invent them. */
function parsePerformances(event: Record<string, unknown>): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const locName =
    event.location && typeof event.location === "object"
      ? (event.location as Record<string, unknown>).name
      : null;
  const venue = typeof locName === "string" ? stripHtml(locName) || null : null;
  const cancelled = typeof event.eventStatus === "string" && /Cancelled/i.test(event.eventStatus);

  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const field of ["startDate", "endDate"] as const) {
    const raw = event[field];
    const m = typeof raw === "string" ? raw.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/) : null;
    if (!m) continue;
    const date = m[1] as IsoDate;
    const time = m[2] ?? null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time,
      venue_room: venue,
      status: cancelled ? "cancelled" : date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/**
 * Cast + creative team from `.cast-person` cards, WHEN the page rendered them
 * server-side (the shared widget often injects them client-side, leaving these
 * empty — acceptable). A card with a `.character` is sung cast (that's the role);
 * a card with a `.role` is a production-team credit (that's the function label).
 * The `.name` is an `<a>` link or bare text.
 */
function parseCredits(html: string): { cast: RawCredit[]; creative_team: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(
    /<div class='cast-person[^']*'>([\s\S]*?)<div style='clear:both;'>/g,
  )) {
    const card = m[1] ?? "";
    const nameRaw = card.match(/<div class='name'>([\s\S]*?)<\/div>/)?.[1] ?? "";
    const name = stripHtml(nameRaw.replace(/<a[^>]*>([\s\S]*?)<\/a>/, "$1"));
    if (!name) continue;

    const character = stripHtml(card.match(/<div class='character'>([\s\S]*?)<\/div>/)?.[1] ?? "");
    const roleLabel = stripHtml(card.match(/<div class='role'>([\s\S]*?)<\/div>/)?.[1] ?? "");

    if (character) {
      const key = `cast|${character}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role: character, name });
    } else if (roleLabel) {
      const fn = CREATIVE_FUNCTIONS[roleLabel.toLowerCase()];
      if (!fn) continue;
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    }
  }
  return { cast, creative_team };
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
