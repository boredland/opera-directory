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
 * Teatro Regio Torino (`spielplan-html` strategy). The Turin fondazione lirica
 * runs one "opera e balletto" season: staged opera and ballet share the same URL
 * tree and detail-page template, so the composer byline alone cannot filter the
 * billings (ballets carry a composer too — Čajkovskij for Swan Lake). The opera
 * gate is instead the presence of a sung voice-type cast (Soprano / Tenore / …):
 * ballets list dancers with no voice type, operas list singers with one.
 *
 * The site is a Drupal install with no JSON-LD and no public API; each detail
 * page is server-rendered with everything inline:
 *   - composer in the `<h1 class="views-field views-field-title">{Title}<span> |
 *     {Composer}</span></h1>` byline — REQUIRED (combined with the voice gate);
 *   - performances as `views-field-field-event-config-date-1` rows carrying a
 *     `<time datetime="YYYY-MM-DDTHH:MM:SSZ">HH:MM</time>`. The trailing `Z` is
 *     spurious (the times are Europe/Rome local), so the displayed `HH:MM` text
 *     is trusted over the datetime's clock;
 *   - cast as artist rows: `field-role` (character) + `views-field-name` (voice
 *     type, the opera gate) + `field-artist-ref` (the singer's name);
 *   - creative team in a `view-opera-details` block of `<strong …value>{Name}
 *     </strong><span …label-ref>{label}</span>` rows — note name precedes label,
 *     and one label can combine functions ("regia, scene, costumi, coreografia e
 *     luci"), each mapped via CREATIVE_LABELS.
 *
 * Detail URLs live under `/opera-e-balletto-{YYYY-YYYY}/{slug}`; the season index
 * at `/biglietti/opera-e-balletto-{YYYY-YYYY}` lists them, and the homepage links
 * the current + next season indexes (robust across the season rollover). The site
 * exposes no walkable deep archive (older season URL patterns 404), so pre-current
 * history comes from Wikidata (Q183202, ~92 works) in backfill mode.
 */

const BASE = "https://www.teatroregio.torino.it";
const HOME_URL = `${BASE}/`;
const CALENDAR_OPERA_URL = `${BASE}/calendario/opera`;
/** Teatro Regio on Wikidata — verified via wbsearchentities (it) → the building
 *  entity Q183202 (label "Teatro Regio", P31 = opera house Q153562, P17 = Italy
 *  Q38), which carries 92 works via P4647 (premiere here) / P272 (produced here).
 *  The sibling *fondazione* entity (Q55372505) carries zero — Q183202 is the
 *  production-bearing one. */
const WIKIDATA_QID = "Q183202";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/**
 * The opera gate: a staged opera lists at least one of these sung voice types in
 * its cast (`views-field-name`); a ballet lists dancers with no voice type. Folds
 * in the English mirror's vocabulary so the gate survives a site-language flip.
 */
const VOICE_TYPES =
  /soprano|mezzosoprano|contralto|tenore|baritono|basso|controtenore|countertenor|tenor|bass|baritone/i;

/**
 * Italian creative-function labels → canonical function keys, tested in order. A
 * single label can combine functions ("regia, scene, costumi, coreografia e
 * luci"), so a row is matched against every rule, not just the first. "Regia" is
 * its own rule (director) independent of the set/costume rules; chorus-master
 * precedes the generic conductor rule. English equivalents are folded in.
 * Production-staff labels with no canonical function (regista collaboratore,
 * assistente, ripresa, allestimento) match nothing and are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro|chorus master/i, "chorus-master"],
  [/direttore|direzione musicale|maestro concertatore|conductor/i, "conductor"],
  [/\bregia\b|staging|director/i, "director"],
  [/coreograf|choreograph/i, "choreographer"],
  [/disegno luci|light designer|\bluci\b|\bluce\b|lights|lighting/i, "lighting"],
  [/\bcostumi\b|costumes/i, "costume-designer"],
  [/scenografia|\bscene\b|\bsets?\b|set design/i, "set-designer"],
  [/drammaturgia|dramaturgy/i, "dramaturgy"],
];

export async function scrapeTeatroRegioTorino(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const detailUrls = await discoverDetailUrls(ctx);

    const today = new Date().toISOString().slice(0, 10);
    for (const detailUrl of detailUrls) {
      try {
        const prod = await buildProduction(detailUrl, ctx, since, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-regio-torino: ${detailUrl} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-regio-torino: season scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-regio-torino: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-regio-torino", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/**
 * Collect the season's detail URLs. The homepage links the current + next season
 * ticket indexes (`/biglietti/opera-e-balletto-{YYYY-YYYY}`), each of which lists
 * every `/opera-e-balletto-{YYYY-YYYY}/{slug}` billing; the `/calendario/opera`
 * page and the homepage itself link the same detail pages directly, so all three
 * are merged for completeness across the rollover (next season's details appear
 * before its ticket index is fully populated).
 */
async function discoverDetailUrls(ctx: FetchContext): Promise<Set<string>> {
  const urls = new Set<string>();
  const indexPages = new Set<string>([HOME_URL, CALENDAR_OPERA_URL]);

  const home = await fetchHtml(HOME_URL, ctx);
  collectDetailLinks(home, urls);
  for (const [, path] of home.matchAll(/href="(\/biglietti\/opera-e-balletto-\d{4}-\d{4})"/gi)) {
    if (path) indexPages.add(`${BASE}${path}`);
  }

  for (const indexUrl of indexPages) {
    if (indexUrl === HOME_URL) continue;
    try {
      collectDetailLinks(await fetchHtml(indexUrl, ctx), urls);
    } catch (err) {
      console.warn(`teatro-regio-torino: index ${indexUrl} failed:`, err);
    }
  }
  return urls;
}

/** Add every `/opera-e-balletto-{YYYY-YYYY}/{slug}` detail link on a page (both
 *  opera and ballet — the opera gate runs later on the detail page). */
function collectDetailLinks(html: string, into: Set<string>): void {
  for (const [, path] of html.matchAll(/href="(\/opera-e-balletto-\d{4}-\d{4}\/[a-z0-9-]+)"/gi)) {
    if (path) into.add(`${BASE}${path}`);
  }
}

async function buildProduction(
  detailUrl: string,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  const html = await fetchHtml(detailUrl, ctx);

  const titleBlock = html.match(/<h1 class="views-field views-field-title">([\s\S]*?)<\/h1>/i)?.[1];
  if (!titleBlock) return null;

  const title = cleanText(titleBlock.replace(/<span>[\s\S]*$/i, ""));
  const composer = parseComposer(titleBlock);
  if (!title || !composer) return null;

  const cast = parseCast(html);
  // Opera gate: a staged opera lists sung voice types; a ballet does not.
  if (!cast.some((c) => c.voice && VOICE_TYPES.test(c.voice))) return null;

  const performances = parsePerformances(html, since, today);
  if (performances.length === 0) return null;

  return {
    source_production_id: slugFromUrl(detailUrl),
    work_title: title,
    composer_name: composer,
    premiere_season: parseSeason(detailUrl),
    detail_url: detailUrl,
    image_url: parseImage(html),
    creative_team: parseCreativeTeam(html),
    cast: cast.map(({ role, name }) => ({ role, name })),
    performances,
  };
}

/** Composer = the `<span> | {Composer}</span>` byline inside the title h1. Absent
 *  on the rare billing with no byline → the production is dropped (opera gate). */
function parseComposer(titleBlock: string): string | null {
  const m = titleBlock.match(/<span>\s*\|\s*([\s\S]*?)<\/span>/i);
  const name = m ? cleanText(m[1] ?? "") : "";
  return name || null;
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}

/** Season from the detail URL path (`/opera-e-balletto-2025-2026/…` → "2025/26"). */
function parseSeason(url: string): string | null {
  const m = url.match(/opera-e-balletto-(\d{4})-(\d{4})/i);
  return m ? `${m[1]}/${m[2]?.slice(2)}` : null;
}

function parseImage(html: string): string | null {
  return html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1] ?? null;
}

/**
 * Performances from `views-field-field-event-config-date-1` rows, each carrying a
 * `<time datetime="YYYY-MM-DDTHH:MM:SSZ">HH:MM</time>`. The datetime's `Z` is
 * spurious (times are Europe/Rome local), so the date is read off the datetime's
 * day and the time off the displayed `HH:MM` text. The per-singer date views
 * (which reuse the same `<time>` shape with a day-number label) live under a
 * different class and are not matched here.
 */
function parsePerformances(html: string, since: IsoDate | null, today: string): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const [, iso, display] of html.matchAll(
    /views-field-field-event-config-date-1">[\s\S]*?<time datetime="([^"]+)">([^<]*)<\/time>/gi,
  )) {
    if (!iso) continue;
    const date = iso.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (since && date < since) continue;
    const time = display?.match(/(\d{1,2})[:.](\d{2})/);
    const hhmm = time ? `${time[1]?.padStart(2, "0")}:${time[2]}` : null;
    const key = `${date}|${hhmm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date: date as IsoDate,
      time: hhmm,
      venue_room: "Teatro Regio",
      status: date < today ? "past" : "scheduled",
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

interface CastRow extends RawCredit {
  /** The sung voice type (Soprano / Tenore / …), used only by the opera gate. */
  voice: string | null;
}

/**
 * Cast rows: each artist block carries `views-field-field-role` (the character),
 * `views-field-name` (the voice type — the opera gate signal), and
 * `views-field-field-artist-ref` (the singer's name). The voice type is kept on
 * the row for the gate but not emitted as a credit. Ensemble names are dropped.
 */
function parseCast(html: string): CastRow[] {
  const out: CastRow[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /views-field-field-role">\s*<span class="field-content">([\s\S]*?)<\/span>[\s\S]*?views-field-name">\s*<span class="field-content">([\s\S]*?)<\/span>[\s\S]*?views-field-field-artist-ref">\s*<div class="field-content">([\s\S]*?)<\/div>/gi,
  )) {
    const role = cleanText(m[1] ?? "");
    const voice = cleanText(m[2] ?? "") || null;
    const name = cleanName(m[3] ?? "");
    if (!role || !name) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, voice, name });
  }
  return out;
}

/**
 * Creative team from the `view-opera-details` block: `<strong …value>{Name}
 * </strong><span …label-ref>{label}</span>` rows where the name precedes the
 * label. A label can combine functions ("regia, scene, costumi, coreografia e
 * luci"), so it is matched against every CREATIVE_LABELS rule and the one name is
 * emitted once per matched function.
 */
function parseCreativeTeam(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const [, rawName, rawLabel] of html.matchAll(
    /field-opera-detail-value">([\s\S]*?)<\/strong>\s*<span class="views-field views-field-field-opera-details-label-ref">([\s\S]*?)<\/span>/gi,
  )) {
    const label = cleanText(rawLabel ?? "");
    for (const person of splitNames(cleanName(rawName ?? ""))) {
      for (const fn of mapFunctions(label)) {
        const key = `${fn}|${person}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ function: fn, name: person });
      }
    }
  }
  return out;
}

/** Every canonical function a (possibly combined) Italian label maps to. */
function mapFunctions(label: string): string[] {
  const fns: string[] = [];
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label) && !fns.includes(fn)) fns.push(fn);
  return fns;
}

/** A credit value may list several people; split on commas / " e ". Drop ensemble
 *  names (orchestra, coro) — they aren't individual performers we model. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+e\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s));
}

/** Typographic / accented entities the shared `decodeEntities` map omits but that
 *  show up in Italian names (Čajkovskij, l'elisir). */
const EXTRA_ENTITIES: Record<string, string> = {
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&scaron;": "š",
  "&Scaron;": "Š",
  "&zcaron;": "ž",
  "&Zcaron;": "Ž",
  "&ccaron;": "č",
  "&Ccaron;": "Č",
};

/** A person name as printed, with the "(Regio Ensemble)" / "(…)" trailing
 *  affiliation hints the cast block appends stripped off. */
function cleanName(html: string): string {
  return cleanText(html)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

function cleanText(html: string): string {
  const pre = html.replace(/&[A-Za-z]+;/g, (m) => EXTRA_ENTITIES[m] ?? m);
  return decodeEntities(stripHtml(pre)).replace(/\s+/g, " ").trim();
}
