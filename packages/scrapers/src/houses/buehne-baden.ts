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
import { isoFromParts } from "./_dates";
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Bühne Baden / Stadttheater Baden (`spielplan-html` strategy).
 *
 * The operetta house of Baden bei Wien (with its open-air Sommerarena), mixing
 * Operette and Oper with Musical, Schauspiel and Konzert. The site is a
 * German-language Nuxt app, but the relevant content is server-rendered HTML —
 * no schema.org Event JSON-LD (only a WebSite blob) and no readable JSON API
 * (the `window.__NUXT__` hydration state is a minified IIFE), so we parse the
 * SSR markup directly.
 *
 * Two steps. The season production index `/de/spielplan/produktionen` lists one
 * `<li class="teaser-item">` card per production carrying the title
 * (`teaser-item__title`), a genre+composer subline (`teaser-item__subline`,
 * e.g. "Operette von Carl Zeller") and the detail URL
 * `/de/produktionen/{slug}/{id}` with a stable numeric id. Per kept production
 * we fetch the detail page for the dated performances (`event-item` blocks) and
 * the cast + creative team (`roles__item` rows).
 *
 * GENRE FILTER (the opera gate). The card subline is both the genre token and
 * the composer source, exactly the Wiener Volksoper shape: keep iff it names the
 * genre "Oper"/"Operette" AND a composer is parseable (`composerFromText`). That
 * drops "Musical von …", "Schauspiel mit Musik von …", the children's workshops
 * ("Einführungsworkshops …") and the gala/concert formats, none of which read as
 * Oper/Operette. On the detail page each `event-item` also carries its own genre
 * label, so non-performance rows interleaved into a kept operetta (e.g. an
 * "Einführungsgespräch" tagged "Special") are dropped at the performance level.
 *
 * Discovery is the current-season production index; the site exposes no
 * server-rendered past-season archive (older `/de/spielzeit-*` routes are
 * client-only and 404 on fetch), so backfill is Wikidata-only.
 *
 * Per detail page the credit table is `<li class="roles__item">` with a
 * `<span class="roles__name">{label}</span>` and one or more `<strong>{name}</strong>`;
 * a label the German credit map knows ("Musikalische Leitung", "Inszenierung")
 * is a creative function, the rest are sung roles (verbatim fallback).
 */

const BASE = "https://www.buehnebaden.at";
const PRODUKTIONEN_URL = `${BASE}/de/spielplan/produktionen`;

/** Stadttheater Baden on Wikidata — Q2328187 ("Stadttheater Baden", "theatre in
 *  Baden near Vienna, Austria", instance-of theatre building Q24354). Verified
 *  via wbsearchentities (the only current-venue hit; the 1812–1908 record
 *  Q60603372 is the demolished predecessor, and Q135905863 "Bühne Baden" is the
 *  event-series record). Neither building nor series carries any P4647/P272
 *  productions today, so the Wikidata backfill is an (empty) resolution anchor. */
const WIKIDATA_QID = "Q2328187";

/** German full month names as printed in `date-element__date` (incl. the
 *  Austrian "Jänner"), mapped to their two-digit month for ISO dates. */
const MONTHS: Record<string, string> = {
  jänner: "01",
  januar: "01",
  februar: "02",
  märz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

/** A production card from the season index, pre-gate. */
interface ProductionCard {
  id: string;
  detailUrl: string;
  title: string;
  subline: string;
}

export async function scrapeBuehneBaden(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const cards = await collectCards(ctx);
    for (const card of cards) {
      const composer = composerFromText(card.subline);
      if (!isOperaOrOperetta(card.subline) || !composer) continue;
      try {
        const prod = await buildProduction(card, composer, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`buehne-baden: production ${card.id} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("buehne-baden: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("buehne-baden: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "buehne-baden", productions };
}

const TEASER_RE = /<li\b[^>]*class="[^"]*teaser-item[^"]*"[\s\S]*?<\/li>/g;

/** Parse the season production index into one card per production. */
async function collectCards(ctx: FetchContext): Promise<ProductionCard[]> {
  const html = await fetchHtml(PRODUKTIONEN_URL, ctx);
  const cards: ProductionCard[] = [];
  const seen = new Set<string>();

  for (const [item] of matchAllSingle(html, TEASER_RE)) {
    const urlMatch = item.match(/\/de\/produktionen\/([a-z0-9-]+)\/(\d+)/i);
    const titleMatch = item.match(/teaser-item__title">([^<]*)</);
    const sublineMatch = item.match(/teaser-item__subline[^"]*">([^<]*)</);
    if (!urlMatch?.[1] || !urlMatch?.[2] || !titleMatch?.[1]) continue;

    const id = urlMatch[2];
    if (seen.has(id)) continue;
    seen.add(id);

    cards.push({
      id,
      detailUrl: `${BASE}/de/produktionen/${urlMatch[1]}/${id}`,
      title: decodeEntities(titleMatch[1]).trim(),
      subline: sublineMatch?.[1] ? decodeEntities(sublineMatch[1]).trim() : "",
    });
  }
  return cards;
}

/** The opera gate: keep "Oper"/"Operette" sublines, drop Musical/Schauspiel/
 *  Ballett/Konzert/workshop formats. The composer gate (caller) handles the
 *  genre-less sublines (cast teasers, "Sommerworkshop") that slip past this. */
function isOperaOrOperetta(subline: string): boolean {
  const s = subline.toLowerCase();
  if (/musical|schauspiel|ballett|konzert|workshop|gala/.test(s)) return false;
  return /\boperette?\b|\boper\b/.test(s);
}

async function buildProduction(
  card: ProductionCard,
  composer: string,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(card.detailUrl, ctx);
  const { creative_team, cast } = parseCredits(html);
  const performances = parsePerformances(html, window);

  return {
    source_production_id: `buehne-baden/${card.id}`,
    work_title: card.title,
    composer_name: composer,
    detail_url: card.detailUrl,
    creative_team,
    cast,
    performances,
  };
}

const EVENT_ITEM_RE =
  /<div\b[^>]*class="event-item border-bottom"[\s\S]*?(?=<div\b[^>]*class="event-item border-bottom"|<footer)/g;

/**
 * Dated performances from the detail page's `event-item` blocks. Each carries a
 * German date ("Fr, 26. Juni" + a `<span>2026</span>` year), a time
 * ("19:30 Uhr"), a per-event genre label and a venue room
 * (`labels__item--room`, e.g. Sommerarena / Stadttheater / Max-Reinhardt-Foyer).
 * We drop rows whose genre label isn't Oper/Operette (intro talks tagged
 * "Special", etc.) and honour `window.since`.
 */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const perfs: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [block] of matchAllSingle(html, EVENT_ITEM_RE)) {
    const genreMatch = block.match(/labels__item--genre[^>]*>\s*([^<]*?)\s*</);
    if (genreMatch?.[1] && !isOperaOrOperetta(genreMatch[1])) continue;

    const date = parseGermanDate(block);
    if (!date) continue;
    if (window.since && date < window.since) continue;

    const timeMatch = block.match(/date-element__time">\s*(\d{1,2}:\d{2})/);
    const time = timeMatch?.[1] ?? null;
    const roomMatch = block.match(/labels__item--room[^>]*>\s*([^<]*?)\s*</);
    const venue = roomMatch?.[1] ? decodeEntities(roomMatch[1]).trim() : null;

    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    perfs.push({
      date,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }

  perfs.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return perfs;
}

const DATE_RE = /date-element__date[^>]*>\s*\w+,\s*(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s*<span>(\d{4})/;

/** "Fr, 26. Juni <span>2026" → "2026-06-26". */
function parseGermanDate(block: string): IsoDate | null {
  const m = block.match(DATE_RE);
  if (!m?.[1] || !m?.[2] || !m?.[3]) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return isoFromParts(m[3], month, m[1]);
}

const ROLE_ITEM_RE = /<li\b[^>]*class="roles__item[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
const ROLE_NAME_RE = /roles__name">([\s\S]*?)<\/span>/;
const STRONG_RE = /<strong>([\s\S]*?)<\/strong>/g;

/**
 * Cast + creative team from the `roles__item` rows: a `roles__name` label plus
 * one or more `<strong>{name}</strong>`. A label the German credit map knows is
 * a creative function ("Musikalische Leitung" → conductor); the rest are sung
 * roles. A row may list several names (e.g. two directors, alternating casts).
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, inner] of matchAllPairSingle(html, ROLE_ITEM_RE)) {
    const labelMatch = inner.match(ROLE_NAME_RE);
    const label = labelMatch?.[1] ? stripHtml(labelMatch[1]) : "";
    if (!label) continue;

    for (const [, rawName] of matchAllPairSingle(inner, STRONG_RE)) {
      const name = stripHtml(rawName);
      if (!name) continue;

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
  }

  return { creative_team, cast };
}

/** matchAll wrapper yielding [full] tuples — keeps adapters regex-only, no eval. */
function* matchAllSingle(html: string, re: RegExp): Generator<[string]> {
  for (const m of html.matchAll(re)) yield [m[0]];
}

/** matchAll wrapper yielding [full, g1] tuples. */
function* matchAllPairSingle(html: string, re: RegExp): Generator<[string, string]> {
  for (const m of html.matchAll(re)) yield [m[0], m[1] ?? ""];
}
