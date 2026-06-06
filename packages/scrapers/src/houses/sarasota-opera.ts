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
 * Sarasota Opera (`spielplan-html` strategy) — US opera company in Sarasota,
 * Florida (US/English), staging a compact winter/spring season in the historic
 * Sarasota Opera House, and known for its multi-decade Verdi Cycle. The live
 * scrape is the announced season; `backfill` appends Wikidata (currently empty
 * for this company, so backfill yields nothing — the deep past is not on the wire).
 *
 * Drupal 9. Production metadata and ticketing live on two hosts and a scrape must
 * stitch them: the marketing site (`/event/{slug}`) has the work, composer and
 * cast/staff but only a date *range*; the Tessitura TNEW ticketing site
 * (`tickets.sarasotaopera.org`) has the individual performance dates/times. There
 * is no public JSON-LD and no usable Tessitura JSON API (the TNEW `api/*`
 * endpoints 302 without a session), so both legs are parsed from SSR HTML.
 *
 *   - index: the announced-season landing page (`/2026-27-season`) links every
 *     production at `/event/{slug}` — the canonical source of slugs (the sitemap
 *     and `/events` views carry none). The season path is discovered from a
 *     `{yy}-{yy}-season` link on the homepage so it rolls over automatically.
 *   - composer (the opera gate): the structured "<strong>Composer &amp;
 *     Premiere:</strong> {Name}; premiered…" prose line — an ENGLISH field, NOT
 *     German composerFromText. A "Music by / Music and Libretto by {Name}" line is
 *     the fallback. NOT taken from any cast card (Ariadne's "The Composer" is a
 *     sung character, not the work's composer).
 *   - cast + staff: uniform `cast-list-item` cards, each `<h5 class="character-name">
 *     {label}</h5> <p class="performer-name">{Name}</p>`. There is no markup split
 *     between singers and crew, so the label IS the discriminator: a label in
 *     CREATIVE_FUNCTIONS (Conductor, Stage Director, …) is creative; anything else
 *     is a sung role and goes to cast.
 *   - performances: the production's Buy-Tickets button points at
 *     `tickets.sarasotaopera.org/overview/{id}`; that page lists each night as
 *     `tn-prod-list-item__perf-date` + `…__perf-time`. Tickets are date-gated only
 *     (no sold-out flags this far out), so status is past/scheduled by date. Venue
 *     is the Sarasota Opera House.
 *
 * Opera filter: REQUIRE a composer AND a dated performance, and drop the Youth
 * Opera strand (a per-production `<p class="event-tag">Sarasota Youth Opera</p>`).
 */

/** Named HTML entities the shared `decodeEntities` table doesn't carry but that
 *  show up in Czech/Slavic opera names this house stages (Leoš Janáček, Dvořák,
 *  Libuše…). Pre-substituted before the shared decoder runs. */
const EXTRA_ENTITIES: Record<string, string> = {
  scaron: "š",
  Scaron: "Š",
  zcaron: "ž",
  Zcaron: "Ž",
  ccaron: "č",
  Ccaron: "Č",
  rcaron: "ř",
  Rcaron: "Ř",
  ncaron: "ň",
  ecaron: "ě",
};

/** Decode the entities the shared table misses, then run the shared decoder and
 *  collapse whitespace/tags. The single text-cleanup path for this adapter. */
function clean(text: string): string {
  const pre = text.replace(/&([a-z]+);/gi, (m, name) => EXTRA_ENTITIES[name] ?? m);
  return stripHtml(decodeEntities(pre)).trim();
}

const BASE = "https://www.sarasotaopera.org";
const TICKETS = "https://tickets.sarasotaopera.org";
const VENUE = "Sarasota Opera House";

/** Sarasota Opera on Wikidata — the opera COMPANY (Q7423237, "non-profit
 *  organization in the USA"), NOT the Sarasota Opera House building (Q5820035,
 *  "opera house in Sarasota, Florida, United States"). Verified via
 *  wbsearchentities on "Sarasota Opera": Q7423237 is the company, Q5820035 the
 *  venue. */
const WIKIDATA_QID = "Q7423237";

/** English cast-card labels that name a production *function* (not a sung role) →
 *  our canonical function slugs. A label absent here is treated as a sung role and
 *  kept verbatim as cast; unmodeled crew labels would simply read as cast, so the
 *  set is kept tight to what this house actually prints. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "costume designer": "costume-designer",
  "costume coordinator": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeSarasotaOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectEventSlugs(ctx)) {
      try {
        const prod = await parseProduction(slug, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`sarasota-opera: event ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("sarasota-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("sarasota-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "sarasota-opera", productions };
}

/** The announced-season landing page (`/{yy}-{yy}-season`, discovered from the
 *  homepage so it rolls over) links every production at `/event/{slug}`. The
 *  homepage itself is a fallback when the season link can't be found. */
async function collectEventSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  const home = await fetchHtml(`${BASE}/`, ctx);

  const seasonPaths = new Set<string>();
  for (const [, path] of home.matchAll(
    /href="https:\/\/www\.sarasotaopera\.org\/(\d{4}-\d{2}-season)"/g,
  )) {
    if (path) seasonPaths.add(path);
  }

  const indexes = [...seasonPaths].map((p) => `${BASE}/${p}`);
  indexes.push(`${BASE}/`);
  for (const url of indexes) {
    try {
      const html = url.endsWith("/") ? home : await fetchHtml(url, ctx);
      for (const [, slug] of html.matchAll(
        /href="https:\/\/www\.sarasotaopera\.org\/event\/([^"#]+)"/g,
      )) {
        if (slug) slugs.add(slug);
      }
    } catch (err) {
      console.warn(`sarasota-opera: index ${url} failed:`, err);
    }
  }
  return [...slugs];
}

async function parseProduction(
  slug: string,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/event/${slug}`;
  const html = await fetchHtml(detailUrl, ctx);

  // Youth Opera is out of scope; its per-production tag is the reliable marker
  // (the nav's "Sarasota Youth Opera" link is on every page and is not used here).
  if (/<p class="event-tag">\s*Sarasota Youth Opera\s*<\/p>/i.test(html)) return null;

  const composer = parseComposer(html);
  // No composer ⇒ not staged opera (a concert/recital/gala). This is the opera gate.
  if (!composer) return null;

  const overviewId = parseOverviewId(html);
  const performances = overviewId ? await parsePerformances(overviewId, ctx, window) : [];
  if (performances.length === 0) return null;

  const title = parseTitle(html, slug);
  if (!title) return null;

  const { cast, creative_team } = parseCredits(html);

  return {
    source_production_id: `sarasota-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: detailUrl,
    cast,
    creative_team,
    performances,
  };
}

/** "<strong>Composer &amp; Premiere:</strong> {Name}; premiered…" — the
 *  structured ENGLISH field present on every production; the value runs to the
 *  first semicolon. Falls back to the "Music by / Music and Libretto by {Name}"
 *  byline (value runs to ", Libretto" or the closing tag). */
function parseComposer(html: string): string | null {
  // "Composer & Premiere:" — the &nbsp; that pads the label sometimes sits inside
  // the </strong> and sometimes outside it, so allow either; the name runs to the
  // first semicolon ("; premiered…").
  const premiere = html.match(/Composer\s*(?:&amp;|&)\s*Premiere:[\s\S]*?<\/strong>\s*([^<]+)/i);
  if (premiere) {
    // The value runs "{Name}; premiered…" — drop the "; premiered…" clause (a name
    // can itself contain a numeric/named entity with its own ';', e.g. "Leoš"), then
    // decode entities and strip the label's trailing &nbsp; that bleeds in.
    const name = clean((premiere[1] ?? "").replace(/;\s*premiered[\s\S]*$/i, ""));
    if (name && /[A-Za-z]/.test(name)) return name;
  }
  // "Music by / Music and Libretto by {Name}" byline; the name stops before a
  // ", Libretto by …" continuation or the next tag.
  const byline = html.match(
    /Music\s+(?:by|and Libretto by)\s+([^<]+?)\s*(?:,?\s*(?:and\s+)?Libretto|<)/i,
  );
  if (byline) {
    const name = clean(byline[1] ?? "");
    if (name && /[A-Za-z]/.test(name)) return name;
  }
  return null;
}

/** The production's Buy-Tickets button links a bare
 *  `tickets.sarasotaopera.org/overview/{id}`; the site-wide "Gift Shop" link uses
 *  the same path with a `?psn=` query, so the one WITHOUT a query is the production. */
function parseOverviewId(html: string): string | null {
  for (const [, id, trailing] of html.matchAll(
    /tickets\.sarasotaopera\.org\/overview\/(\d+)(["'?])/g,
  )) {
    if (trailing !== "?") return id ?? null;
  }
  return null;
}

function parseTitle(html: string, slug: string): string | null {
  const h1 = clean(html.match(/<h1 class="page-title[^"]*">([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (h1) return h1;
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (og) {
    const title = clean(og)
      .replace(/\s*[-–|]\s*Sarasota Opera\s*$/i, "")
      .trim();
    if (title) return title;
  }
  return slugToTitle(slug);
}

/** Cast and staff share `cast-list-item` cards: `<h5 class="character-name">
 *  {label}</h5> <p class="performer-name">{Name}</p>`. A label in
 *  CREATIVE_FUNCTIONS is a production function (creative); any other label is a
 *  sung role (cast, kept verbatim for the resolver). */
function parseCredits(html: string): { cast: RawCredit[]; creative_team: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, labelRaw, nameRaw] of html.matchAll(
    /<h5 class="character-name">([\s\S]*?)<\/h5>\s*<p class="performer-name">([\s\S]*?)<\/p>/g,
  )) {
    const label = clean(labelRaw ?? "");
    const name = clean(nameRaw ?? "");
    if (!label || !name) continue;

    const fn = lookupFunction(label);
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
  return { cast, creative_team };
}

/** Map a staff label to a function slug. Combined labels like "Stage
 *  Director/Choreographer" map on their first segment so they don't fall through. */
function lookupFunction(label: string): string | null {
  const lower = label.toLowerCase().trim();
  if (CREATIVE_FUNCTIONS[lower]) return CREATIVE_FUNCTIONS[lower] ?? null;
  const first = lower.split(/\s*[/&]\s*/)[0]?.trim() ?? "";
  return CREATIVE_FUNCTIONS[first] ?? null;
}

/** Performance dates/times come from the Tessitura TNEW overview page, one row per
 *  night: `tn-prod-list-item__perf-date` ("February 6, 2027") +
 *  `…__perf-time` ("7:30PM"). Status is date-derived (no sold-out flags appear this
 *  far ahead; tickets are sold on-site). Honors window.since. */
async function parsePerformances(
  overviewId: string,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawPerformance[]> {
  const html = await fetchHtml(`${TICKETS}/overview/${overviewId}`, ctx);
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, dateText, timeText] of html.matchAll(
    /tn-prod-list-item__perf-date">([^<]+)<\/span>\s*<span class="tn-prod-list-item__perf-time">([^<]*)<\/span>/g,
  )) {
    const date = parseDate(dateText ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;
    const time = parseTime(timeText ?? "");
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

/** "February 6, 2027" → "2027-02-06". */
function parseDate(text: string): IsoDate | null {
  const m = text.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[(m[1] ?? "").toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${(m[2] ?? "").padStart(2, "0")}` as IsoDate;
}

/** "7:30PM" / "1:30PM" → 24h "HH:MM"; null when no time is printed. */
function parseTime(text: string): string | null {
  const m = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hour = Number.parseInt(m[1] ?? "", 10);
  const meridian = (m[3] ?? "").toUpperCase();
  if (meridian === "PM" && hour !== 12) hour += 12;
  if (meridian === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/-\d+$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
