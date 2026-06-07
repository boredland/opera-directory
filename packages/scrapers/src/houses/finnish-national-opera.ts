import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Finnish National Opera ("Suomen Kansallisooppera", `json-api` strategy) — the
 * national opera company of Finland, in Helsinki, SHARED with the Finnish
 * National Ballet on one WordPress site (oopperabaletti.fi). The whole adapter is
 * therefore gated to staged opera; two independent facets do that:
 *   - the WP REST `genre` taxonomy — the English "opera" term is id 547. We list
 *     `wp/v2/production?lang=en&genre=547`, so ballet/dance/concert productions
 *     never enter the set in the first place.
 *   - a composer requirement — every staged opera credits a "Säveltäjä"
 *     (composer) in its creative-team `<dl>`; ballet/concert/gala pages do not.
 *     No composer ⇒ dropped. (composerFromText is German-only and unused — the
 *     composer is read from this structured field.)
 *
 * The repertoire grid is client-rendered, but the WordPress backend exposes a
 * clean JSON API, so no headless render is needed:
 *   - `wp/v2/production?lang=en&genre=547` lists the published opera productions
 *     (~50) with the full Gutenberg `content.rendered` HTML inline. The server
 *     renders each blob slowly, so the whole set in one call overruns the fetch
 *     timeout — we page at PAGE_SIZE (the API also rate-limits parallel requests,
 *     so the pages are fetched sequentially).
 *   - `ooppera/events?production={id}` returns every dated performance for that
 *     production (date+time, venue, sale status) in one call.
 *
 * The content HTML is parsed for the bits the API doesn't structure:
 *   - Composer + title — the hero carries "Composer – Librettist" in
 *     `<div class="hero-toptext"><p>` and the title in `<h1 wp-block-post-title>`.
 *     The composer is the segment before the en-dash.
 *   - Creative team — a `<dl class="production-cast">` of `<dt>` label / `<dd>`
 *     name(s). The labels are FINNISH even on the English locale (Säveltäjä,
 *     Ohjaus, Kapellimestari, …), so the Finnish map is the primary one here;
 *     comma-separated and `<a>`-linked names are split. Unmapped labels (Libretisti
 *     and the like) are dropped.
 *   - Cast — `<div class="production-role">` blocks pairing `<dt>` (role) with
 *     `<dd>` (singer); alternating casts repeat a role across blocks.
 *
 * `backfill` additionally appends Wikidata premieres/productions for the deep
 * past (Finnish operas back to the 1920s) the live repertoire doesn't reach.
 */

const BASE = "https://oopperabaletti.fi";
const REST = `${BASE}/wp-json`;
/** The English "opera" genre term in the shared opera/ballet WP taxonomy. */
const OPERA_GENRE_EN = 547;
/** Page size for the production list. Small enough that one page's rendered
 *  Gutenberg HTML stays under the fetch timeout (the full set in one call doesn't). */
const PAGE_SIZE = 10;

/** Finnish National Opera on Wikidata — the opera COMPANY (Q1418002, "opera
 *  company in Helsinki, Finland"), not the Q118398102 "Finnish National Opera
 *  House" building. Verified via wbsearchentities ("Finnish National Opera" →
 *  Q1418002). Backfill is non-empty (Finnish-opera premieres carry P4647/P1191). */
const WIKIDATA_QID = "Q1418002";

/**
 * Creative-team labels → our canonical function slugs. The labels come back in a
 * MIX of Finnish and English even on the English locale (per-row translation is
 * uneven — one production reads "set design", the next "Lavastussuunnittelu"), so
 * both are mapped. "Säveltäjä"/"Music" (composer) is handled separately as the
 * opera gate. A `<dt>` whose label is unmapped (e.g. "Libretisti") is not emitted.
 */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  kapellimestari: "conductor",
  conductor: "conductor",
  ohjaus: "director",
  director: "director",
  "stage director": "director",
  lavastus: "set-designer",
  lavastussuunnittelu: "set-designer",
  "set design": "set-designer",
  "set designer": "set-designer",
  puvut: "costume-designer",
  pukusuunnittelu: "costume-designer",
  "costume design": "costume-designer",
  "costume designer": "costume-designer",
  valot: "lighting",
  valosuunnittelu: "lighting",
  "light design": "lighting",
  "lighting design": "lighting",
  "lighting designer": "lighting",
  koreografia: "choreographer",
  choreography: "choreographer",
  choreographer: "choreographer",
  kuoronjohtaja: "chorus-master",
  "chorus master": "chorus-master",
  dramaturgia: "dramaturgy",
  dramaturg: "dramaturgy",
  dramaturgy: "dramaturgy",
};

/** Composer labels (Finnish "Säveltäjä" / English "Music"); presence gates opera. */
const COMPOSER_LABELS = new Set(["säveltäjä", "composer", "music"]);

interface WpProduction {
  id: number;
  slug: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
  class_list?: string[];
}

interface OopperaEvent {
  id: number;
  location?: string | null;
  status?: string | null;
  start_date?: string | null;
}

interface OopperaEventsResponse {
  events: OopperaEvent[];
}

export async function scrapeFinnishNationalOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const wp of await listOperaProductions(ctx)) {
      try {
        const prod = await buildProduction(wp, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`finnish-national-opera: production ${wp.slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("finnish-national-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("finnish-national-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "finnish-national-opera", productions };
}

/** Page through the English opera productions. The server renders the inline
 *  Gutenberg HTML per row, so a page (PAGE_SIZE) is the largest chunk that stays
 *  under the fetch timeout; stop on the first short/empty page. */
async function listOperaProductions(ctx: FetchContext): Promise<WpProduction[]> {
  const all: WpProduction[] = [];
  const fields = "id,slug,link,title,content,class_list";
  for (let page = 1; page <= 50; page++) {
    const url =
      `${REST}/wp/v2/production?lang=en&genre=${OPERA_GENRE_EN}` +
      `&per_page=${PAGE_SIZE}&page=${page}&_fields=${fields}`;
    let batch: WpProduction[];
    try {
      batch = await fetchJson<WpProduction[]>(url, ctx);
    } catch (err) {
      // A request past the last page 400s; treat any page error as the end.
      if (page === 1) throw err;
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

async function buildProduction(
  wp: WpProduction,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = wp.content?.rendered ?? "";
  const { composer, creative_team } = parseCreativeTeam(html);
  // No composer ⇒ not a staged opera (ballet/concert/gala that slipped the genre
  // facet). This is the opera gate.
  if (!composer) return null;

  const title = parseTitle(html, wp.title?.rendered ?? wp.slug);
  if (!title) return null;

  const performances = await parsePerformances(wp.id, ctx, window);
  if (performances.length === 0) return null;

  return {
    source_production_id: `finnish-national-opera/${wp.id}`,
    work_title: title,
    composer_name: composer,
    detail_url: wp.link,
    image_url: parseHeroImage(html),
    creative_team,
    cast: parseCast(html),
    performances,
  };
}

function parseTitle(html: string, fallback: string): string {
  const m = html.match(/<h1[^>]*class="wp-block-post-title"[^>]*>([\s\S]*?)<\/h1>/);
  return stripHtml(m?.[1] ?? "") || stripHtml(fallback);
}

/** Parse the `<dl class="production-cast">` creative-team table. Returns the
 *  composer (the opera gate, read from the "Säveltäjä"/"Music" row) and the mapped
 *  credits. The composer is taken only from this structured row, never the hero
 *  byline — that byline is sometimes "Company – Composer – Librettist", so guessing
 *  the first segment there would emit a company name as the composer. */
function parseCreativeTeam(html: string): { composer: string | null; creative_team: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();
  let composer: string | null = null;

  const dl = html.match(/<dl class="production-cast">([\s\S]*?)<\/dl>/)?.[1] ?? "";
  for (const [, dt, dd] of dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    const label = stripHtml(dt ?? "").toLowerCase();
    if (!label) continue;

    if (COMPOSER_LABELS.has(label)) {
      composer = splitNames(dd ?? "")[0] ?? null;
      continue;
    }

    const fn = CREATIVE_FUNCTIONS[label];
    if (!fn) continue;
    for (const name of splitNames(dd ?? "")) {
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    }
  }

  return { composer, creative_team };
}

/** Cast from the `<div class="production-role">` blocks, each carrying one
 *  `<dt>` role + `<dd>` singer. Alternating casts repeat a role across blocks
 *  (kept as separate rows). */
function parseCast(html: string): RawCredit[] {
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const [, block] of html.matchAll(
    /<div class="production-role">([\s\S]*?<dt>[\s\S]*?<\/dd>)/g,
  )) {
    const role = stripHtml(block?.match(/<dt>([\s\S]*?)<\/dt>/)?.[1] ?? "");
    const name = splitNames(block?.match(/<dd>([\s\S]*?)<\/dd>/)?.[1] ?? "")[0];
    if (!name) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cast.push({ role: role || null, name });
  }
  return cast;
}

function parseHeroImage(html: string): string | null {
  const m = html.match(/data-landscapeImage="([^"]+)"/);
  return m?.[1] ?? null;
}

/** A `<dd>` holds one or more comma-separated names, each possibly wrapped in an
 *  `<a>` link. Strip tags/entities and split on commas. */
function splitNames(dd: string): string[] {
  return stripHtml(decodeEntities(dd))
    .split(",")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Every dated performance for a production, from `ooppera/events?production={id}`.
 *  `start_date` is "YYYY-MM-DD HH:MM(:SS)"; location is the venue (Finnish even on
 *  the EN locale). Honors window.since. */
async function parsePerformances(
  id: number,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawPerformance[]> {
  const today = new Date().toISOString().slice(0, 10);
  const data = await fetchJson<OopperaEventsResponse>(
    `${REST}/ooppera/events?lang=en&production=${id}`,
    ctx,
  );

  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const ev of data.events ?? []) {
    const m = (ev.start_date ?? "").match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (!m) continue;
    const [, y, mo, d, h, min] = m;
    const date = `${y}-${mo}-${d}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = h ? `${h}:${min}` : null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time,
      venue_room: ev.location ?? null,
      status: eventStatus(ev.status, date, today),
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

function eventStatus(
  status: string | null | undefined,
  date: IsoDate,
  today: string,
): RawPerformance["status"] {
  if (date < today) return "past";
  switch (status) {
    case "sold_out":
    case "sold-out":
      return "sold_out";
    case "some_left":
    case "last_tickets":
      return "few_left";
    default:
      return "scheduled";
  }
}
