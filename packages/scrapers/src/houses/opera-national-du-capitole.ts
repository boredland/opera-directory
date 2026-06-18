import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchJson } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Opéra national du Capitole, Toulouse (`json-api` strategy). Programming is an
 * `onct-events` WordPress custom post type whose list payload carries everything
 * (no per-detail fetch): `meta` holds the structured run + a composer byline, and
 * `content.rendered` holds the distribution as Gutenberg markup.
 *   - genre gate: the `onct-event-type` taxonomy — term 5 ("Opéra"), applied
 *     server-side via `?onct-event-type=5`;
 *   - composer (opera gate): `meta.onct-event-short-desc` is the composer byline
 *     ("Luigi Cherubini (1760-1842)") — life-dates trimmed;
 *   - run: `meta.onct-event-timestamp` (opening) + `onct-event-end-timestamp`
 *     (closing) Unix seconds. The house does NOT publish the individual nights
 *     anywhere extractable (the dated mentions in the body are audiodescription
 *     séances / talks), so we emit the opening and — for a multi-day run — the
 *     closing performance, both with real local date+time; middle nights are not
 *     available;
 *   - creative team: the ocre-styled `<strong><em>Label</em></strong>` paragraphs
 *     before the "distribution" heading, each followed by a `<strong>Name</strong>`;
 *   - cast: `Role <strong>Singer</strong>` rows after the "distribution" heading,
 *     dropping ensemble lines (orchestre / chœur).
 *
 * Deep past comes from Wikidata (Q3091701) in backfill mode.
 */

const BASE = "https://opera.toulouse.fr";
const REST_EVENTS = `${BASE}/wp-json/wp/v2/onct-events`;
const VENUE = "Théâtre du Capitole";
/** Opéra national du Capitole — verified via wbsearchentities: Q3091701, P31 =
 *  opera company / opera house, P17 = France (Q142). */
const WIKIDATA_QID = "Q3091701";
/** `onct-event-type` term id for staged opera — the server-side genre gate. */
const OPERA_TYPE_ID = 5;

const RECENT_PAST_DAYS = 45;
const PER_PAGE = 100;
const MAX_PAGES = 8;

/** French creative-function labels → canonical function keys, tested in order. */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/chef?\s+de\s+ch[œoe]ur|direction\s+du\s+ch[œoe]ur|chorus master/i, "chorus-master"],
  [/direction\s+musicale|chef\s+d['’]orchestre|conductor/i, "conductor"],
  [/mise\s+en\s+sc[èe]ne|stage director|staging/i, "director"],
  [/chor[ée]graph/i, "choreographer"],
  [/lumi[èe]res?|[ée]clairages?|lighting/i, "lighting"],
  [/sc[ée]nographie|d[ée]cors?|set design/i, "set-designer"],
  [/costumes?/i, "costume-designer"],
  [/dramaturg/i, "dramaturgy"],
  [/vid[ée]o/i, "video"],
];

/** Ensemble / non-person cast lines to drop (they're not a sung character role). */
const ENSEMBLE = /orchestre|ch[œoe]ur|ensemble|ballet|ma[îi]trise|chef\s+de\s+ch/i;

interface ToulouseEvent {
  slug?: string;
  link?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
  meta?: Record<string, unknown>;
}

export async function scrapeOperaNationalDuCapitole(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);
    for (const event of await fetchOperaEvents(ctx)) {
      const prod = buildProduction(event, since, today);
      if (prod) productions.push(prod);
    }
  } catch (err) {
    console.warn("opera-national-du-capitole: events scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opera-national-du-capitole: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "opera-national-du-capitole", productions };
}

function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** Every opera `onct-events` row (server-side filtered to the opera type). The
 *  list payload includes `content` + `meta`, so one paginated sweep is the house. */
async function fetchOperaEvents(ctx: FetchContext): Promise<ToulouseEvent[]> {
  const rows: ToulouseEvent[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let batch: ToulouseEvent[];
    try {
      batch = await fetchJson<ToulouseEvent[]>(
        `${REST_EVENTS}?onct-event-type=${OPERA_TYPE_ID}&per_page=${PER_PAGE}&page=${page}&orderby=date&order=desc`,
        ctx,
      );
    } catch {
      break; // 400s past the last page
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return rows;
}

function buildProduction(
  event: ToulouseEvent,
  since: IsoDate | null,
  today: string,
): RawProduction | null {
  const composer = parseComposer(event.meta);
  if (!composer) return null; // opera gate

  const title = decodeEntities(event.title?.rendered ?? "").trim();
  if (!title) return null;

  const performances = parsePerformances(event.meta, since, today);
  if (performances.length === 0) return null;

  const html = event.content?.rendered ?? "";
  const slug = event.slug ?? slugFromUrl(event.link ?? "");

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: event.link ?? null,
    creative_team: parseCreative(html),
    cast: parseCast(html),
    performances,
  };
}

/** Composer from `onct-event-short-desc`, dropping trailing life-dates / extras. */
function parseComposer(meta: Record<string, unknown> | undefined): string | null {
  const raw =
    typeof meta?.["onct-event-short-desc"] === "string" ? meta["onct-event-short-desc"] : "";
  const name = decodeEntities(String(raw))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s*\(.*$/, "") // "(1760-1842)" and anything after
    .replace(/\s+/g, " ")
    .trim();
  return name && name.length <= 60 ? name : null;
}

/** Opening (and, for a multi-day run, closing) performance from the Unix run
 *  bounds, formatted in Europe/Paris local time (handles DST). */
function parsePerformances(
  meta: Record<string, unknown> | undefined,
  since: IsoDate | null,
  today: string,
): RawPerformance[] {
  const start = toInt(meta?.["onct-event-timestamp"]);
  const end = toInt(meta?.["onct-event-end-timestamp"]);
  const oneDay = meta?.["onct-event-one-day"] === true || meta?.["onct-event-one-day"] === "1";
  if (!start) return [];

  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  const add = (ts: number) => {
    const local = parisLocal(ts);
    if (!local) return;
    if (since && local.date < since) return;
    const key = `${local.date}|${local.time}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      date: local.date,
      time: local.time,
      venue_room: VENUE,
      status: local.date < today ? "past" : "scheduled",
    });
  };

  add(start);
  if (!oneDay && end && end - start > 12 * 3600) add(end);
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** A Unix-seconds instant → Europe/Paris local `{ date, time }`. */
function parisLocal(ts: number): { date: IsoDate; time: string } | null {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  // 'sv-SE' renders "YYYY-MM-DD HH:MM:SS"; the timeZone option applies the Paris offset.
  const s = new Date(ts * 1000).toLocaleString("sv-SE", { timeZone: "Europe/Paris" });
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (!m) return null;
  return { date: m[1] as IsoDate, time: m[2] as string };
}

/** Creative team from the ocre-styled `<strong><em>Label</em></strong>` paragraphs
 *  (each followed by a plain `<strong>Name</strong>`), before the cast section. */
function parseCreative(html: string): RawCredit[] {
  const creativeHtml = splitAtDistribution(html)[0];
  const out: RawCredit[] = [];
  let label: string | null = null;
  for (const m of creativeHtml.matchAll(/<strong>\s*(<em>)?([\s\S]*?)(<\/em>)?\s*<\/strong>/g)) {
    const isLabel = Boolean(m[1]);
    const text = cleanText(m[2] ?? "");
    if (!text) continue;
    if (isLabel) {
      label = text;
      continue;
    }
    const fn = label ? mapLabel(label) : null;
    if (fn) for (const name of splitNames(text)) out.push({ function: fn, name });
    label = null;
  }
  return out;
}

/**
 * Cast from the character/singer paragraph pairs: a role is an ocre `<em>Role</em>`
 * paragraph (the `</em></p>` boundary distinguishes it from a creative label, whose
 * `<em>` sits inside `<strong>`), immediately followed by a `<strong>Singer</strong>`
 * paragraph. Marketing blurbs carry no `<em>` role, so they're naturally excluded.
 */
function parseCast(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  const re =
    /<em>\s*([^<]{2,48}?)\s*<\/em>\s*<\/p>\s*<p[^>]*>\s*<strong>\s*([^<]{2,60}?)\s*<\/strong>/g;
  for (const m of html.matchAll(re)) {
    const role = cleanText(m[1] ?? "");
    const name = cleanText(m[2] ?? "");
    if (!role || !name) continue;
    if (ENSEMBLE.test(role) || ENSEMBLE.test(name)) continue;
    if (mapLabel(role)) continue; // a creative label, not a sung character
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name });
  }
  return out;
}

function splitAtDistribution(html: string): [string, string] {
  const i = html.search(/>\s*distribution\s*</i);
  return i < 0 ? [html, ""] : [html.slice(0, i), html.slice(i)];
}

function mapLabel(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

function splitNames(raw: string): string[] {
  return raw
    .split(/\s*(?:&|,| et )\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/[:–-]\s*$/, "")
    .trim();
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function seasonOf(date?: IsoDate): string | null {
  if (!date) return null;
  const [y, m] = date.split("-").map(Number) as [number, number];
  const start = m >= 8 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}
