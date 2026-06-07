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
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Theater an der Wien / MusikTheater an der Wien (`spielplan-html` strategy).
 *
 * Vienna's third opera house — contemporary, baroque and rediscovered repertoire
 * staged stagione across two venues, the main house (Theater an der Wien) and the
 * Kammeroper. The site is a German-language "echonet" CMS serving SSR HTML — no
 * schema.org Event JSON-LD and no public JSON API — so this reads the rendered
 * markup directly across three views that each expose one piece:
 *
 *   - the genre-filtered season listing `/de/spielplan[/saison{YYYY-YY}]?filter=cat_1`
 *     — the OPERA GATE. The house mixes staged opera/operetta (category "Szenisches
 *     Musiktheater", `cat_1`, which subsumes the `cat_4` Familienoper) with
 *     concertante opera (`cat_3`), masterclasses, tours and concerts. Only `cat_1`
 *     is staged opera, so that listing is the whitelist of production ids; each box
 *     carries the work title (`<h3>`), the composer (`<p class="subtitle">`), a
 *     venue (`<p class="location">`) and a date *range* (`<p class="date">`).
 *   - the calendar `/de/kalendarium` — the only view with per-night dates. Flat
 *     `<li class="cfix">` rows, each a single dated performance carrying a
 *     `<time datetime>`, an `HH.MM` time, the venue and the production detail URL
 *     (`/de/spielplan/saison{YYYY-YY}/{id}/{slug}`). Covers the full announced
 *     future; past seasons are not in it.
 *   - the production detail page — the cast + creative team (`<div class="cast-person">`
 *     blocks: `<p class="castrole"><strong>{label}</strong></p>` +
 *     `<h3 class="castname">{name}</h3>`). It carries NO performance dates.
 *
 * The gate is two-pronged and lives on the cheap listing: a production is kept iff
 * it is in the `cat_1` set AND its subtitle reads as a composer name (a real person,
 * not a descriptive tour blurb like "Eine abenteuerliche Entdeckungsreise …"). That
 * drops concertante evenings, guided tours, masterclasses and concert formats.
 *
 * Incremental joins the current + next season `cat_1` whitelist to the kalendarium
 * for per-night dates (falling back to the listing range when a kept production has
 * no calendar rows, e.g. an already-played run). Backfill walks the season archive
 * back to `window.since` (the live archive bottoms out at 2022/23 — the renovation
 * years are absent) using the listing's date range, then appends Wikidata.
 */

const BASE = "https://www.theater-wien.at";

/** Theater an der Wien on Wikidata — Q374336 ("Theater an der Wien", "historic
 *  theatre and opera building in Vienna"). Verified via wbsearchentities AND by
 *  SPARQL: it carries 50+ productions via P4647/P272 (Fidelio, Die Fledermaus,
 *  Die lustige Witwe …), whereas the separate "theatre company" record
 *  Q119138280 carries 1 — so the building QID is the one with backfill data. */
const WIKIDATA_QID = "Q374336";

/** How far back the backfill season walk reaches; the live archive bottoms out
 *  around 2022/23 (renovation years absent), so this is a generous cap. */
const MAX_BACKFILL_SEASONS = 30;

/** A staged-opera production from the `cat_1` season listing (the opera gate). */
interface ListingEntry {
  productionId: string;
  detailUrl: string;
  title: string;
  composer: string;
  venue: string;
  /** Inclusive [start, end] from the listing's "DD.MM.YYYY–DD.MM.YYYY" range. */
  range: [IsoDate, IsoDate] | null;
}

export async function scrapeTheaterAnDerWien(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const entries =
      window.mode === "backfill" ? await collectArchive(ctx, window) : await collectCurrent(ctx);
    const performancesById =
      window.mode === "backfill" ? new Map<string, RawPerformance[]>() : await collectCalendar(ctx);

    for (const entry of entries) {
      try {
        const prod = await buildProduction(
          entry,
          performancesById.get(entry.productionId),
          ctx,
          window,
        );
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-an-der-wien: production ${entry.productionId} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-an-der-wien: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-an-der-wien: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "theater-an-der-wien", productions };
}

/** The opera whitelist for the announced future: the current + next season's
 *  staged-opera (`cat_1`) listings, deduped by production id. */
async function collectCurrent(ctx: FetchContext): Promise<ListingEntry[]> {
  const byId = new Map<string, ListingEntry>();
  for (const url of [
    `${BASE}/de/spielplan?filter=cat_1`,
    `${BASE}/de/spielplan/${currentSeasonSlug(1)}?filter=cat_1`,
  ]) {
    try {
      for (const e of parseListing(await fetchHtml(url, ctx))) {
        if (!byId.has(e.productionId)) byId.set(e.productionId, e);
      }
    } catch (err) {
      console.warn(`theater-an-der-wien: listing ${url} failed:`, err);
    }
  }
  return [...byId.values()];
}

/** Walk the season archive backward via its slug (`saison{YYYY-YY}`), filtered to
 *  staged opera, until a season's range falls entirely before `window.since`. */
async function collectArchive(ctx: FetchContext, window: ScrapeWindow): Promise<ListingEntry[]> {
  const byId = new Map<string, ListingEntry>();
  for (let back = 0; back < MAX_BACKFILL_SEASONS; back++) {
    const slug = currentSeasonSlug(-back);
    const seasonEnd = `${seasonStartYear(-back) + 1}-08-31` as IsoDate;
    if (window.since && seasonEnd < window.since) break;
    let entries: ListingEntry[];
    try {
      entries = parseListing(await fetchHtml(`${BASE}/de/spielplan/${slug}?filter=cat_1`, ctx));
    } catch (err) {
      // The archive bottoms out at 2022/23 (renovation years absent); a 404 is the
      // floor, not a transient error — stop walking rather than log noise for each
      // missing prior season.
      if (/→ 404$/.test(String(err))) break;
      console.warn(`theater-an-der-wien: archive ${slug} failed:`, err);
      continue;
    }
    for (const e of entries) {
      if (window.since && e.range && e.range[1] < window.since) continue;
      if (!byId.has(e.productionId)) byId.set(e.productionId, e);
    }
  }
  return [...byId.values()];
}

const BOX_RE = /<li class="box b(\d+)[^"]*">([\s\S]*?)<\/li>/g;

/** Parse the `cat_1` listing's production boxes into the opera whitelist, dropping
 *  any box whose subtitle is a descriptive blurb rather than a composer name. */
function parseListing(html: string): ListingEntry[] {
  const out: ListingEntry[] = [];
  const seen = new Set<string>();
  for (const [, productionId, body] of matchAllPair(html, BOX_RE)) {
    const detail = body.match(/href="(\/de\/spielplan\/saison[0-9-]+\/\d+\/[^"]+)"/);
    const titleM = body.match(/<h3>([\s\S]*?)<\/h3>/);
    const subM = body.match(/class="subtitle">([\s\S]*?)<\/p>/);
    if (!detail?.[1] || !titleM?.[1]) continue;

    const composer = subM?.[1] ? cleanText(subM[1]) : "";
    if (!looksLikeComposer(composer)) continue;
    if (seen.has(productionId)) continue;
    seen.add(productionId);

    const locM = body.match(/class="location">([\s\S]*?)<\/p>/);
    const dateM = body.match(/class="date">([\s\S]*?)<\/p>/);

    out.push({
      productionId,
      detailUrl: `${BASE}${detail[1]}`,
      title: cleanText(titleM[1]),
      composer,
      venue: locM?.[1] ? cleanText(locM[1]) : VENUE_FALLBACK,
      range: parseRange(dateM?.[1] ?? ""),
    });
  }
  return out;
}

const VENUE_FALLBACK = "Theater an der Wien";

const CAL_ITEM_RE = /<li class="cfix">([\s\S]*?)<\/li>/g;

/**
 * Per-night performances from the calendar, keyed by production id. Each row is a
 * single dated showing: `<time datetime>` (the date), an `HH.MM` time and the
 * venue, plus the detail URL that carries the production id. Status is derived from
 * the date — the live ticket state loads via an ajax shoplink not in the SSR DOM.
 */
async function collectCalendar(ctx: FetchContext): Promise<Map<string, RawPerformance[]>> {
  const byId = new Map<string, RawPerformance[]>();
  let html: string;
  try {
    html = await fetchHtml(`${BASE}/de/kalendarium`, ctx);
  } catch (err) {
    console.warn("theater-an-der-wien: kalendarium failed:", err);
    return byId;
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const [, body] of matchAllSingleGroup(html, CAL_ITEM_RE)) {
    const idM = body.match(/href="\/de\/spielplan\/saison[0-9-]+\/(\d+)\/[^"]+"/);
    const dateM = body.match(/<time\b[^>]*datetime="(\d{4}-\d{2}-\d{2})/);
    if (!idM?.[1] || !dateM?.[1]) continue;

    const timeM = body.match(/class="time">\s*(\d{1,2})[.:](\d{2})/);
    const time = timeM?.[1] && timeM[2] ? `${timeM[1].padStart(2, "0")}:${timeM[2]}` : null;
    const venueM = body.match(/class="house_wrap">([\s\S]*?)<\/div>/);

    const date = dateM[1] as IsoDate;
    const list = byId.get(idM[1]) ?? [];
    list.push({
      date,
      time,
      venue_room: venueM?.[1] ? cleanText(venueM[1]) : VENUE_FALLBACK,
      status: date < today ? "past" : "scheduled",
    });
    byId.set(idM[1], list);
  }

  return byId;
}

/**
 * Build a production from its listing entry, its calendar performances (when the
 * calendar covers it) and the detail page's cast block. When no calendar rows
 * exist (archived runs, or a current run already played out), fall back to the
 * listing's date range so the production still carries a dated performance.
 */
async function buildProduction(
  entry: ListingEntry,
  calendar: RawPerformance[] | undefined,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  let performances = (calendar ?? []).filter((p) => !window.since || p.date >= window.since);
  if (performances.length === 0 && entry.range) {
    performances = rangeToPerformances(entry.range, entry.venue, window.since);
  }
  if (performances.length === 0) return null;

  let creative_team: RawCredit[] = [];
  let cast: RawCredit[] = [];
  try {
    ({ creative_team, cast } = parseCredits(await fetchHtml(entry.detailUrl, ctx)));
  } catch (err) {
    console.warn(`theater-an-der-wien: detail ${entry.detailUrl} failed:`, err);
  }

  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  return {
    source_production_id: `theater-an-der-wien/${entry.productionId}`,
    work_title: entry.title,
    composer_name: entry.composer,
    detail_url: entry.detailUrl,
    creative_team,
    cast,
    performances,
  };
}

/** The listing only gives a date range; without per-night dates emit the range
 *  endpoints (deduped) so the production is still dated and discoverable. */
function rangeToPerformances(
  [start, end]: [IsoDate, IsoDate],
  venue: string,
  since: IsoDate | null,
): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const dates = start === end ? [start] : [start, end];
  return dates
    .filter((d) => !since || d >= since)
    .map((date) => ({
      date,
      time: null,
      venue_room: venue,
      status: date < today ? ("past" as const) : ("scheduled" as const),
    }));
}

const CAST_RE = /<div class="cast-person">([\s\S]*?)<h3 class="castname">([\s\S]*?)<\/h3>/g;

/**
 * Cast + creative team from `<div class="cast-person">` blocks: a
 * `<p class="castrole"><strong>{label}</strong></p>` label and the
 * `<h3 class="castname">{name}</h3>`. A label the German credit map knows
 * ("Musikalische Leitung", "Inszenierung und Bühne") is a creative function; the
 * rest are sung roles (verbatim fallback). Deduped — a role can repeat (alternating
 * casts, multiple dancers).
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, block, rawName] of matchAllPair(html, CAST_RE)) {
    const name = cleanText(rawName);
    if (!name) continue;
    const labelM = block.match(/class="castrole">\s*<strong>([\s\S]*?)<\/strong>/);
    const label = labelM?.[1] ? cleanText(labelM[1]) : "";
    if (!label) continue;

    const credit = normalizeGermanCredit(label, name);
    if (credit.function) {
      const key = `${credit.function}|${name}`;
      if (seenCreative.has(key)) continue;
      seenCreative.add(key);
      creative_team.push(credit);
    } else {
      const key = `${label}|${name}`;
      if (seenCast.has(key)) continue;
      seenCast.add(key);
      cast.push({ role: label, name });
    }
  }

  return { creative_team, cast };
}

/** Decode entities, drop soft hyphens, collapse whitespace; for a tag's text. */
function cleanText(html: string): string {
  return stripHtml(html).replace(/­/g, "");
}

/**
 * A subtitle is a composer iff it reads like one or more person names, not a
 * descriptive blurb. Composer lines carry "/" (double bills), "u. a." and commas
 * (multiple composers) but no German prose connectives ("durch", "eine", "und
 * mehr"); blurbs like "Eine abenteuerliche Entdeckungsreise durch das Theater an
 * der Wien" do, and run long.
 */
function looksLikeComposer(text: string): boolean {
  const t = text
    .trim()
    .replace(/,?\s*u\.\s?a\.?$/i, "")
    .trim();
  if (t.length < 3 || t.length > 80) return false;
  if (/\b(eine|einen|durch|das|der|die|den|für|mit|nach|über|sowie)\b/i.test(t)) return false;
  return /^[A-ZÄÖÜ]/.test(t);
}

/** Parse the listing's "DD.MM.YYYY–DD.MM.YYYY" (or single "DD.MM.YYYY") range. */
function parseRange(text: string): [IsoDate, IsoDate] | null {
  const dates = [...stripHtml(text).matchAll(/(\d{2})\.(\d{2})\.(\d{4})/g)].map(
    ([, d, m, y]) => `${y}-${m}-${d}` as IsoDate,
  );
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return null;
  return [first, last];
}

/** German opera seasons run Aug–Jul; `offset` shifts by whole seasons (−1 = prior). */
function seasonStartYear(offset: number): number {
  const now = new Date();
  const base = now.getMonth() + 1 >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return base + offset;
}

/** Season URL slug, e.g. "saison2025-26" for the current season (offset 0). */
function currentSeasonSlug(offset: number): string {
  const start = seasonStartYear(offset);
  return `saison${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** matchAll wrapper yielding [full, g1] tuples — keeps adapters regex-only, no eval. */
function* matchAllSingleGroup(html: string, re: RegExp): Generator<[string, string]> {
  for (const m of html.matchAll(re)) yield [m[0], m[1] ?? ""];
}

/** matchAll wrapper yielding [full, g1, g2] tuples. */
function* matchAllPair(html: string, re: RegExp): Generator<[string, string, string]> {
  for (const m of html.matchAll(re)) yield [m[0], m[1] ?? "", m[2] ?? ""];
}
