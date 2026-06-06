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
 * Lyric Opera of Kansas City (`spielplan-html` strategy) — US opera company in
 * Kansas City, Missouri (US/English), season ~Sep–May on the Kauffman Center's
 * Muriel Kauffman Theatre. The live scrape is the announced + recent season;
 * `backfill` appends Wikidata for the deep past.
 *
 * WordPress (GenerateBlocks). Ticketing is Tessitura (tickets.kcopera.org/TNEW
 * responds), but the production metadata — composer, cast, creative team — lives
 * only on the marketing-site `/event/{slug}/` pages, so we scrape those. The
 * `event` post type is not REST-exposed and the `production` taxonomy holds a
 * single stray term, so discovery is the `event-sitemap.xml` index. Each opera
 * page yields everything from SSR HTML:
 *   - composer: the `field-set` block's COMPOSER / MUSIC value — an ENGLISH
 *     structured field (NOT the German composerFromText). This is also the opera
 *     gate: galas, lectures, dinners and community events carry no field-set.
 *   - performances: one schema.org `Event` JSON-LD blob per night
 *     (`startDate` local ISO, `eventStatus`, `location.name`). The blobs embed raw
 *     `<img>` HTML in `image`, which breaks JSON.parse, so dates are read by regex.
 *   - cast: `<h3>{name}</h3><p>{role}` cards under the "Principal Cast" heading
 *     (some templates prefix the role with "Role:").
 *   - creative: the same card shape under "Creative Team" — the role line is an
 *     ENGLISH function label, mapped to our slugs INSIDE this adapter (see
 *     CREATIVE_FUNCTIONS); the field-set's CONDUCTOR / DIRECTOR / PRODUCTION lines
 *     supplement it. Unmapped labels (Wig/Make-Up, etc.) are dropped.
 *
 * Every performance is at the Kauffman Center, so the venue is fixed.
 */

const BASE = "https://kcopera.org";
const SITEMAP_URL = `${BASE}/event-sitemap.xml`;
const VENUE = "Kauffman Center";

/** Lyric Opera of Kansas City on Wikidata — the opera COMPANY (Q21197513).
 *  Verified via wbsearchentities: Q21197513 = "Lyric Opera of Kansas City",
 *  description "opera company in Kansas City, Missouri, United States". */
const WIKIDATA_QID = "Q21197513";

/** English function labels (a Creative Team card's role line, or a field-set key)
 *  → our canonical function slugs. Assistant/associate variants fold onto the
 *  principal function; "Production" (the staging credit) maps to director. An
 *  unmapped label (Wig and Make-Up Designer, etc.) is dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "assistant conductor": "conductor",
  "chorus master and assistant conductor": "chorus-master",
  director: "director",
  "stage director": "director",
  production: "director",
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
  "fight choreographer": "choreographer",
  "movement director": "choreographer",
  "director & fight choreographer": "director",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeLyricOperaOfKansasCity(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectEventSlugs(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}/event/${slug}/`, ctx), slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`lyric-opera-of-kansas-city: event ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("lyric-opera-of-kansas-city: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("lyric-opera-of-kansas-city: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "lyric-opera-of-kansas-city", productions };
}

/** The `event-sitemap.xml` lists every `/event/{slug}/` page; the opera gate
 *  (a COMPOSER field-set) downstream drops the galas, lectures and dinners. */
async function collectEventSlugs(ctx: FetchContext): Promise<string[]> {
  const xml = await fetchHtml(SITEMAP_URL, ctx);
  const slugs = new Set<string>();
  for (const [, slug] of xml.matchAll(/\/event\/([^<\s/]+)\//g)) {
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const fields = parseFieldSet(html);
  const composer = fields.composer ?? fields.music;
  // No composer ⇒ a gala / lecture / dinner / community event, not staged opera.
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html, slug);
  if (!title) return null;

  return {
    source_production_id: `lyric-opera-of-kansas-city/${slug}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(fields.language),
    detail_url: `${BASE}/event/${slug}/`,
    creative_team: parseCreative(html, fields),
    cast: parseCards(sectionBetween(html, "Principal Cast", "Creative Team"), "cast"),
    performances,
  };
}

interface FieldSet {
  composer?: string;
  music?: string;
  conductor?: string;
  director?: string;
  production?: string;
  language?: string;
}

/** The `field-set-key`/`field-set-value` pairs (COMPOSER, MUSIC, CONDUCTOR,
 *  DIRECTOR, PRODUCTION, "Understand every word"). Composer markers (* / ^ tying
 *  a name to a half of a double bill) are kept verbatim — ingest normalizes. */
function parseFieldSet(html: string): FieldSet {
  const out: FieldSet = {};
  for (const [, key, value] of html.matchAll(
    /<span class="field-set-key">([\s\S]*?)<\/span>\s*<span class="field-set-value">([\s\S]*?)<\/span>/g,
  )) {
    const k = stripHtml(key ?? "").toLowerCase();
    const v = stripHtml(value ?? "");
    if (!v) continue;
    if (/^composers?$/.test(k)) out.composer = v;
    else if (k === "music") out.music = v;
    else if (k === "conductor") out.conductor = v;
    else if (k === "director") out.director = v;
    else if (k === "production") out.production = v.replace(/^by\s+/i, "").trim();
    else if (/understand every word|performed in/.test(k)) out.language = v;
  }
  return out;
}

/** Creative team = the "Creative Team" section cards, plus the field-set's
 *  CONDUCTOR / DIRECTOR / PRODUCTION lines (which a sparse page may carry without
 *  a card). Deduped by function+name. */
function parseCreative(html: string, fields: FieldSet): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  const push = (fn: string | undefined, name: string) => {
    if (!fn || !name) return;
    const key = `${fn}|${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ function: fn, name });
  };

  push(CREATIVE_FUNCTIONS.conductor, fields.conductor ?? "");
  push(CREATIVE_FUNCTIONS.director, fields.director ?? "");
  if (fields.production) push(CREATIVE_FUNCTIONS.production, fields.production);

  for (const card of parseCards(sectionBetween(html, "Creative Team", null), "creative")) {
    push(card.function ?? undefined, card.name);
  }
  return out;
}

/** Parse the `<h3>{name}</h3><p>{line}…` person cards in an HTML region. For cast,
 *  the line is the sung role (a leading "Role:" label is stripped); for creative,
 *  it's a function label mapped via CREATIVE_FUNCTIONS (unmapped → dropped). */
function parseCards(region: string, kind: "cast" | "creative"): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, rawName, rawBlock] of region.matchAll(
    /<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g,
  )) {
    const name = stripHtml(rawName ?? "");
    if (!name) continue;
    const line = stripHtml((rawBlock ?? "").replace(/<a[\s\S]*$/i, ""))
      .replace(/^Role:\s*/i, "")
      .replace(/\bFull Bio\b/i, "")
      .trim();
    if (!line) continue;

    if (kind === "cast") {
      const key = `${line}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ role: line, name });
    } else {
      const fn = CREATIVE_FUNCTIONS[line.toLowerCase()];
      if (!fn) continue;
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ function: fn, name });
    }
  }
  return out;
}

/** Slice the HTML between two `<h2>` section headings (end = null → to page end). */
function sectionBetween(html: string, startHeading: string, endHeading: string | null): string {
  const start = html.search(new RegExp(`<h2>\\s*${escapeRe(startHeading)}`, "i"));
  if (start < 0) return "";
  const rest = html.slice(start);
  if (!endHeading) return rest;
  const end = rest.search(new RegExp(`<h2>\\s*${escapeRe(endHeading)}`, "i"));
  return end < 0 ? rest : rest.slice(0, end);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Performances are the per-night schema.org `Event` JSON-LD blobs. The blobs
 *  embed raw `<img>` HTML in `image` (breaks JSON.parse), so `startDate` and
 *  `eventStatus` are read by regex. Honors window.since; venue is fixed. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, blob] of html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    const start = blob?.match(/"startDate":\s*"(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
    if (!start) continue;
    const date = start[1] as IsoDate;
    const time = start[2] ?? null;
    if (window.since && date < window.since) continue;

    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const cancelled = /"eventStatus":\s*"[^"]*EventCancelled/i.test(blob ?? "");
    out.push({
      date,
      time,
      venue_room: VENUE,
      status: cancelled ? "cancelled" : date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Prefer the JSON-LD Event name, then the page `<h1>`, then the slug. */
function parseTitle(html: string, slug: string): string | null {
  const ld = html.match(/"@type":\s*"Event",\s*"name":\s*"([^"]+)"/)?.[1];
  if (ld) return decodeEntities(ld).trim();
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (og) {
    const title = decodeEntities(og.replace(/\s*[-–|]\s*Lyric Opera[^|–-]*$/i, "")).trim();
    if (title) return title;
  }
  const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  return h1 || slugToTitle(slug);
}

/** The field-set's "Performed in {Language} with …" line → an ISO 639-1 code. */
function languageCode(note: string | undefined): RawProduction["language"] {
  const lang = note?.match(/Performed in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
  if (!lang) return null;
  return (
    ({
      italian: "it",
      english: "en",
      german: "de",
      french: "fr",
      russian: "ru",
      czech: "cs",
      spanish: "es",
    }[lang] as RawProduction["language"]) ?? null
  );
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
