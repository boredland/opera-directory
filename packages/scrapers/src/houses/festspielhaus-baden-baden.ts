import { decodeEntities, type FetchContext, fetchHtml, fetchRendered, stripHtml } from "../fetch";
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
 * Festspielhaus Baden-Baden (`render` strategy).
 *
 * FESTIVAL/venue — Europe's largest opera-and-concert house. Its programme is
 * overwhelmingly CONCERTS (orchestras, recitals, jazz, ballet, musicals, family
 * shows) with a small OPER strand: a year-round guest opera or two plus the
 * Osterfestspiele (Easter festival, Berliner Philharmoniker). So a live scrape is
 * the CURRENT announced programme filtered hard to opera, plus Wikidata backfill.
 *
 * The /programm/ overview is a Nuxt SPA — no event JSON-LD, list built client-side
 * — so it's read via `fetchRendered`. Each event card carries a genre overline
 * (`c-heading__overline`), a headline title, a subline, an `eventid`, and a date
 * block ("Wochentag D.M.YY HH:MM Uhr"). We keep ONLY genres that start with "Oper"
 * ("Oper", "Oper im Konzert") — dropping every concert, recital, ballet, gala
 * (incl. "Operngala"), musical and family show. Cards with the same eventid are one
 * production grouped over its dates.
 *
 * Detail/credits: cards expose no detail link (a modal), but the Nuxt static
 * payload (`/_nuxt/static/{build}/programm/payload.js`) maps each eventid to a
 * `/veranstaltungen/{slug}/` detail page (we regex that map, never eval the JS).
 * The rendered detail page carries the cast/creative team as `m-artists__role` →
 * `m-artists__name` pairs (German credit labels) and a work-type line ("Oper in
 * zwei Aufzügen … Musik von {Composer}") from which the composer is read. A
 * production is kept only when a composer resolves — the opera gate.
 */

const BASE = "https://www.festspielhaus.de";
const PROGRAMM_URL = `${BASE}/programm/`;
/** Festspielhaus Baden-Baden — verified via wbsearchentities (en description
 *  "opera and concert hall in Baden-Baden, Germany"). */
const WIKIDATA_QID = "Q176342";
const VENUE = "Festspielhaus Baden-Baden";

interface OperEvent {
  eventId: string;
  genre: string;
  title: string;
  subline: string | null;
  performances: RawPerformance[];
}

export async function scrapeFestspielhausBadenBaden(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const operEvents = await parseOperEvents(ctx, window);
    const slugByEventId = await fetchEventSlugMap(ctx);
    for (const ev of operEvents) {
      try {
        const prod = await buildProduction(ctx, ev, slugByEventId.get(ev.eventId) ?? null);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`festspielhaus-baden-baden: event ${ev.eventId} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("festspielhaus-baden-baden: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("festspielhaus-baden-baden: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "festspielhaus-baden-baden", productions };
}

/** Render the programme overview and keep only the Oper-genre event cards, grouped
 *  by `eventid` over their dates. */
async function parseOperEvents(ctx: FetchContext, window: ScrapeWindow): Promise<OperEvent[]> {
  const html = await fetchRendered(PROGRAMM_URL, ctx, { waitMs: 7000 });
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map<string, OperEvent>();

  // A card root carries the eventid; everything up to the next card root is its
  // markup. Cards live both at top level and nested inside festival groupings, so
  // we split on the eventid-bearing root rather than a fixed container class.
  for (const chunk of html.split(/(?=<div class="[^"]*m-quickview-event[^"]*"[^>]*eventid=)/)) {
    const eventId = chunk.match(/eventid="(\d+)"/)?.[1];
    const genreRaw = chunk.match(/c-heading__overline[^>]*>([\s\S]*?)<\/h2>/)?.[1];
    if (!eventId || !genreRaw) continue;

    const genre = stripHtml(genreRaw);
    if (!/^oper(\s|$)/i.test(genre)) continue; // "Oper", "Oper im Konzert"; not "Operngala"

    const title = stripHtml(chunk.match(/c-heading__headline[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "");
    const subline =
      stripHtml(chunk.match(/c-heading__subline[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "") || null;
    const perf = parsePerformance(chunk, today);

    const existing = byId.get(eventId);
    if (existing) {
      if (
        perf &&
        !existing.performances.some((p) => p.date === perf.date && p.time === perf.time)
      ) {
        existing.performances.push(perf);
      }
      continue;
    }
    if (!title) continue;
    byId.set(eventId, {
      eventId,
      genre,
      title,
      subline,
      performances: perf ? [perf] : [],
    });
  }

  const events = [...byId.values()];
  for (const ev of events) {
    ev.performances = ev.performances
      .filter((p) => !window.since || p.date >= window.since)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  }
  return events.filter((ev) => ev.performances.length > 0);
}

/** A card's date block: "<span>Samstag</span> <span>6.6.26</span> <span>14:30 Uhr</span>". */
function parsePerformance(chunk: string, today: string): RawPerformance | null {
  const block = chunk.match(/m-quickview-event__date">([\s\S]*?)<\/div>/)?.[1];
  if (!block) return null;
  const text = stripHtml(block);
  const m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+(\d{1,2}:\d{2}))?/);
  if (!m) return null;
  const [, dd, mm, yy, time] = m;
  if (!dd || !mm || !yy) return null;
  const date = isoFromParts(yy, mm, dd);
  if (!date) return null;
  return {
    date,
    time: time ?? null,
    venue_room: VENUE,
    status: date < today ? "past" : "scheduled",
  };
}

/**
 * The Nuxt static payload maps eventids to detail slugs. It's a minified JSONP
 * blob; we regex the `{eventid},(eventUri:)?"/veranstaltungen/{slug}/"` pairs out
 * of it (URL escapes as `/`) rather than evaluating remote JS.
 */
async function fetchEventSlugMap(ctx: FetchContext): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const programmHtml = await fetchHtml(PROGRAMM_URL, ctx);
    const payloadPath = programmHtml.match(/\/_nuxt\/static\/[^"']*?\/programm\/payload\.js/)?.[0];
    if (!payloadPath) return map;
    const payload = await fetchHtml(`${BASE}${payloadPath}`, ctx);
    const re = /(\d{6,7}),(?:eventUri:)?"\\u002Fveranstaltungen\\u002F([a-z0-9-]+)\\u002F"/g;
    for (const [, eventId, slug] of payload.matchAll(re)) {
      if (eventId && slug && !map.has(eventId)) map.set(eventId, slug);
    }
  } catch (err) {
    console.warn("festspielhaus-baden-baden: payload slug map failed:", err);
  }
  return map;
}

async function buildProduction(
  ctx: FetchContext,
  ev: OperEvent,
  slug: string | null,
): Promise<RawProduction | null> {
  let composer: string | null = null;
  let cast: RawCredit[] = [];
  let creative_team: RawCredit[] = [];
  let title = ev.title;
  const detailUrl = slug ? `${BASE}/veranstaltungen/${slug}/` : null;

  if (detailUrl) {
    const html = await fetchRendered(detailUrl, ctx, { waitMs: 6000 });
    composer = composerFromWorkType(html);
    const credits = parseArtists(html);
    cast = credits.cast;
    creative_team = credits.creative;
    const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
    if (h1) title = h1;
  }

  // The opera gate: a staged/concert opera always names its composer. Without one
  // (e.g. a mislabeled card with no detail page) we drop it rather than guess.
  composer ??= composerFromTitle(title);
  if (!composer) return null;

  title = stripComposerPrefix(title, composer);

  return {
    source_production_id: slug ?? ev.eventId,
    work_title: title,
    composer_name: composer,
    detail_url: detailUrl,
    presentation_note: /im konzert/i.test(ev.genre) ? "Oper im Konzert" : null,
    creative_team,
    cast,
    performances: ev.performances,
  };
}

/** The detail page's work-type line ("… Oper in zwei Aufzügen Musik von {Composer}
 *  Libretto von …"). Minified markup glues words together ("BeethovenDichtung"), so
 *  re-insert spaces at lowercase→uppercase boundaries and cut the libretto tail
 *  before handing it to the shared composer parser. */
function composerFromWorkType(html: string): string | null {
  const plain = stripHtml(html).replace(/([a-zäöü])([A-ZÄÖÜ])/g, "$1 $2");
  const m = plain.match(/Musik von\s+[A-ZÄÖÜ][^.]{0,60}/);
  if (!m) return null;
  const line = m[0].split(/\b(?:Dichtung|Libretto|Text)\b/)[0] ?? m[0];
  return composerFromText(line);
}

/** Card titles are often "Composer: Work" ("Giacomo Puccini: La Bohème"). */
function composerFromTitle(title: string): string | null {
  const m = title.match(/^([A-ZÄÖÜ][^:]{2,40}):\s*\S/);
  return m?.[1] ? composerFromText(`von ${m[1].trim()}`) : null;
}

/** Drop a "Composer: " prefix from the title once the composer is known. */
function stripComposerPrefix(title: string, composer: string): string {
  const surname = composer.split(/\s+/).pop() ?? composer;
  const m = title.match(/^[^:]{2,40}:\s*(.+)$/);
  if (m?.[1] && title.toLowerCase().includes(surname.toLowerCase())) return m[1].trim();
  return title;
}

/** Detail page `m-artists` block: each wrapper is a `m-artists__role` →
 *  `m-artists__name` pair. Mapped German labels → creative team; sung roles → cast;
 *  unlabeled rows (orchestra/chorus) → cast with no role. */
function parseArtists(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, body] of html.matchAll(
    /m-artists__wrapper">([\s\S]*?)(?=m-artists__wrapper">|<\/div><\/div><\/div>)/g,
  )) {
    if (!body) continue;
    const name = stripHtml(decodeEntities(body.match(/m-artists__name">([\s\S]*?)<\//)?.[1] ?? ""));
    if (!name || name === "N.N.") continue;
    const role = stripHtml(decodeEntities(body.match(/m-artists__role">([\s\S]*?)<\//)?.[1] ?? ""));
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!role) {
      cast.push({ role: null, name });
      continue;
    }
    const credit = normalizeGermanCredit(role, name);
    if (credit.function) creative.push(credit);
    else cast.push({ role, name });
  }
  return { cast, creative };
}
