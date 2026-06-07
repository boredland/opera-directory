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
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Theater St. Gallen / Konzert und Theater St. Gallen (`spielplan-html`).
 *
 * A German-language Swiss "Vierspartenhaus" (St. Gallen) presenting Musiktheater
 * (Oper/Operette/Musical), Schauspiel, Tanz and Konzert side by side. The public
 * site is `theatersg.ch`, which 301-redirects to `konzertundtheater.ch`; the
 * pages are SSR HTML on a bespoke CMS — no schema.org Event JSON-LD and no public
 * JSON API — so this reads the rendered markup directly (no headless render).
 *
 * Discovery is the per-season spielplan. The house publishes only the current and
 * the next season (`/programm/spielplan-{SS}-{SS}/`, e.g. `spielplan-25-26`); past
 * seasons 404, so there is no HTML archive — deep history comes from Wikidata. Each
 * season index lists one `<div class="season__production">` per production, carrying
 * the detail-page link and a `data-filter-values` string with a genre token
 * (`Oper`/`Operette`/`Musical`/`Kammerkonzert`/`Orchesterkonzert`). The current
 * season's detail pages already include both already-played and upcoming dates, so
 * the recent-past refresh falls out of scraping the live season.
 *
 * OPERA GATE — two-pronged, cheapest first. (1) The season row's genre token must
 * be `Oper`/`Operette`, which pre-filters the ~140 productions/season down to the
 * handful of operas before any detail page is fetched (drops Musical, Schauspiel,
 * Tanz, Konzert). (2) On the detail page the `<meta name="description">` must begin
 * "{Title}, Oper von …" / "Operette von …", and a composer must parse from that
 * line (via composerFromText) — this is the REQUIRE-a-composer gate and the safety
 * net for a mistagged row.
 *
 * Per detail page:
 *   - title: `<title>{Title} | Konzert und Theater St. Gallen</title>`.
 *   - composer: the "… Oper von {Composer}, …" meta description.
 *   - performances: `productionschedule` rows pairing a `__location` (the room,
 *     e.g. "Grosses Haus") with an `itemprop="startDate"` ISO datetime.
 *   - cast + creative team: `<div class="productioncastandcrew__item">{Label}:
 *     <a>{Name}</a></div>` rows (Leitung/Besetzung). A label the German credit map
 *     knows is a creative function ("Musikalische Leitung" → conductor); the rest
 *     are sung roles (verbatim fallback).
 */

const BASE = "https://www.konzertundtheater.ch";

/** Theater St. Gallen on Wikidata — Q2415961 ("Theater St. Gallen", "theatre and
 *  opera house in the city of St. Gallen"). Verified via wbsearchentities AND by
 *  SPARQL: it is the target of P4647/P272 for the labeled production "Lili Elbe",
 *  whereas the separate "theatre company" record Q113486256 carries 2617 production
 *  items that are ALL unlabeled bare-QIDs (no work title, so the wikidata strategy
 *  skips them) — so the building QID is the one with usable backfill data. */
const WIKIDATA_QID = "Q2415961";

const VENUE = "Theater St. Gallen";

/** A production discovered on a season index, before the detail-page fetch. */
interface ProductionLink {
  detailUrl: string;
  genre: string;
}

export async function scrapeTheaterStGallen(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const links = await collectOperaLinks(ctx);
    for (const link of links) {
      try {
        const html = await fetchHtml(link.detailUrl, ctx);
        const prod = parseProduction(html, link.detailUrl, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-st-gallen: detail ${link.detailUrl} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-st-gallen: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-st-gallen: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "theater-st-gallen", productions };
}

/**
 * Collect opera/operetta detail URLs across every published season. The house
 * exposes only the current + next season, so the season-slug walk probes a small
 * forward/backward band and stops on a 404. The future leg ignores `window.since`
 * — always emit the complete announced future.
 */
async function collectOperaLinks(ctx: FetchContext): Promise<ProductionLink[]> {
  const byUrl = new Map<string, ProductionLink>();

  for (const slug of seasonSlugs()) {
    let html: string;
    try {
      html = await fetchHtml(`${BASE}/programm/${slug}/`, ctx);
    } catch (err) {
      if (!/→ 404$/.test(String(err))) {
        console.warn(`theater-st-gallen: season ${slug} failed:`, err);
      }
      continue;
    }
    for (const link of parseSeasonLinks(html, slug)) {
      if (!byUrl.has(link.detailUrl)) byUrl.set(link.detailUrl, link);
    }
  }

  return [...byUrl.values()];
}

const BLOCK_RE = /<div class="season__production /g;

/**
 * Parse a season index into its opera/operetta production links. Each block
 * carries a `data-filter-values` genre token and a detail-page link; we keep only
 * the blocks whose genre token reads `Oper`/`Operette`.
 */
function parseSeasonLinks(html: string, seasonSlug: string): ProductionLink[] {
  const links: ProductionLink[] = [];
  const hrefRe = new RegExp(`href="(/programm/${seasonSlug}/[a-z0-9-]+/)"`);

  for (const block of splitBlocks(html, BLOCK_RE)) {
    const genre = block.match(/filter-token-genre-\d+:\d+:([^|"]+)/)?.[1]?.trim();
    if (genre !== "Oper" && genre !== "Operette") continue;
    const href = block.match(hrefRe)?.[1];
    if (!href) continue;
    links.push({ detailUrl: `${BASE}${href}`, genre });
  }

  return links;
}

function parseProduction(html: string, url: string, window: ScrapeWindow): RawProduction | null {
  // OPERA GATE — composer comes only from a "… Oper von …" / "Operette von …" meta
  // description, so a null composer drops anything mis-tagged on the season row.
  const composer = parseComposer(html);
  if (!composer) return null;

  const title = parseTitle(html);
  if (!title) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `theater-st-gallen/${parseProductionId(html) ?? slugOf(url)}`,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    image_url: parseImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** Composer from the "{Title}, Oper von {Composer}, Besetzung: …" meta
 *  description. The "Oper von"/"Operette von" prefix is what gates opera in;
 *  composerFromText trims trailing "nach …" / life-date noise. */
function parseComposer(html: string): string | null {
  const m = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  const desc = m?.[1] ? decodeEntities(m[1]) : "";
  if (!/,\s*Oper(ette)?\s+von\s/i.test(desc)) return null;
  const fragment = desc.replace(/^.*?,\s*(Oper(?:ette)?\s+von\s)/i, "$1");
  return composerFromText(fragment.split(",")[0] ?? fragment);
}

/** Title from `<title>{Title} | Konzert und Theater St. Gallen</title>`. */
function parseTitle(html: string): string | null {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return null;
  const t = stripHtml(m[1])
    .replace(/\s*\|\s*Konzert und Theater St\.?\s*Gallen\s*$/i, "")
    .trim();
  return t || null;
}

function parseImage(html: string): string | null {
  const m = html.match(/data-image-url="([^"]+)"/i);
  return m?.[1]?.trim() || null;
}

/** Stable upstream production id from `data-production="…"` on the schedule. */
function parseProductionId(html: string): string | null {
  return html.match(/data-production="(\d+)"/)?.[1] ?? null;
}

const SCHEDULE_RE =
  /productionschedule__location">([^<]*)<\/div>\s*<div class="productionschedule__time"><meta itemprop="startDate" content="(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/g;

/**
 * Performances from the `productionschedule` rows — each pairs the room
 * (`__location`) with an ISO `startDate`. Deduped by date+time and bounded by
 * `window.since`; dates before today are flagged `past`.
 */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, rawRoom, date, time] of matchAllTriple(html, SCHEDULE_RE)) {
    if (window.since && date < window.since) continue;
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const room = stripHtml(rawRoom);
    out.push({
      date: date as IsoDate,
      time,
      venue_room: room || VENUE,
      status: date < today ? "past" : "scheduled",
    });
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

const CREDIT_ITEM_RE = /productioncastandcrew__item">([\s\S]*?)<\/div>/g;

/**
 * Cast + creative team from the `<div class="productioncastandcrew__item">{Label}:
 * {Name}</div>` rows (the Leitung + Besetzung blocks). A label the German credit
 * map knows is a creative function ("Musikalische Leitung" → conductor); the rest
 * are sung roles. Rows with an empty value (e.g. an unfilled "Video:") are skipped.
 * Deduped.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, raw] of matchAllPair(html, CREDIT_ITEM_RE)) {
    const text = stripHtml(raw);
    const sep = text.indexOf(":");
    if (sep < 1) continue;
    const label = text.slice(0, sep).trim();
    const name = text.slice(sep + 1).trim();
    if (!label || !name) continue;

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

/** Current + next season slugs (`spielplan-{SS}-{SS}`) plus a small forward/back
 *  band; only the published ones resolve, the rest 404 and are skipped. */
function seasonSlugs(): string[] {
  const startYear = currentSeasonStartYear();
  const slugs: string[] = [];
  for (let start = startYear - 1; start <= startYear + 1; start++) {
    const a = String(start % 100).padStart(2, "0");
    const b = String((start + 1) % 100).padStart(2, "0");
    slugs.push(`spielplan-${a}-${b}`);
  }
  return slugs;
}

/** Swiss/German opera seasons run Aug–Jul: before August we're still in the
 *  season that started the previous calendar year. */
function currentSeasonStartYear(): number {
  const now = new Date();
  return now.getMonth() + 1 >= 8 ? now.getFullYear() : now.getFullYear() - 1;
}

function slugOf(url: string): string {
  return url.match(/\/([a-z0-9-]+)\/?$/)?.[1] ?? url;
}

/** Split a page on a block-start marker, yielding each block's HTML. Keeps the
 *  per-production parse scoped so a genre token can't leak across blocks. */
function* splitBlocks(html: string, startRe: RegExp): Generator<string> {
  const starts: number[] = [];
  for (const m of html.matchAll(startRe)) starts.push(m.index ?? 0);
  for (let i = 0; i < starts.length; i++) {
    yield html.slice(starts[i], starts[i + 1] ?? html.length);
  }
}

/** matchAll wrapper yielding [full, g1] tuples — keeps adapters regex-only, no eval. */
function* matchAllPair(html: string, re: RegExp): Generator<[string, string]> {
  for (const m of html.matchAll(re)) yield [m[0], m[1] ?? ""];
}

/** matchAll wrapper yielding [full, room, date, time] tuples for the schedule regex. */
function* matchAllTriple(html: string, re: RegExp): Generator<[string, string, string, string]> {
  for (const m of html.matchAll(re)) yield [m[0], m[1] ?? "", m[2] ?? "", m[3] ?? ""];
}
