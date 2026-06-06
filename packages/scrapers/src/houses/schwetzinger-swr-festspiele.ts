import type { IsoDate } from "@opera-directory/schema";
import {
  decodeEntities,
  extractEventJsonLd,
  type FetchContext,
  fetchHtml,
  stripHtml,
} from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Schwetzinger SWR Festspiele (`spielplan-html`, opera-filtered).
 *
 * FESTIVAL — an SWR-run spring festival (~late-Apr–May) in Schloss Schwetzingen,
 * concert-HEAVY with a small staged OPER strand (premieres + co-productions in the
 * barocke Rokokotheater, e.g. 2026: the Bachmann opera "Malina" UA, Monteverdi
 * "L'Orfeo", Rameau "Pygmalion"). It plays one edition at a time then sits empty,
 * so the live leg only ever sees the CURRENT edition and the deep archive of opera
 * premieres comes from Wikidata backfill (Q320221).
 *
 * Live leg: the programme page emits schema.org Event JSON-LD (extractEventJsonLd).
 * The festival's programme is mostly concerts/recitals/Lieder/talks; we keep an
 * event only when it has an opera signal — a "Oper"/"Musiktheater" genre/work-type
 * line OR a composer parsed from an "Oper von X" description — and drop the rest.
 * Events are grouped by work title into one production (the same staging plays a
 * few nights in the Rokokotheater). REQUIRE a composer.
 *
 * Backfill leg: Wikidata Q320221 — verified via wbsearchentities ("Schwetzinger
 * Festspiele"/"Schwetzinger SWR Festspiele" aliases); it carries real production
 * relations (P4647 first-performance + P272 production company) for the festival's
 * notable opera world premieres — Egk's "Der Revisor" (1957), Reimann's "Melusine"
 * (1971), Henze's "The English Cat", Sciarrino's "Luci mie traditrici" (1998).
 *
 * NB: the festival host (gehezu.schwetzinger-swr-festspiele.de) refuses datacenter
 * IPs and was unresponsive through the fetch proxy at build time; the live leg is
 * guarded and best-effort. When the current edition is over and the next isn't
 * published the live leg yields nothing — backfill is then the dependable source.
 */

const BASE = "https://www.schwetzinger-swr-festspiele.de";
const PROGRAMME_URLS = [`${BASE}/programm/`, `${BASE}/programm`, `${BASE}/spielplan/`];
/** Verified via wbsearchentities (de, "Schwetzinger Festspiele" / "Schwetzinger
 *  SWR Festspiele"); has P4647/P272 opera-production relations for backfill. */
const WIKIDATA_QID = "Q320221";

const ROKOKOTHEATER = "Rokokotheater Schwetzingen";

/** A genre/work-type line that marks a staged sung work — drops the festival's
 *  concert/recital/Lieder/talk strands. */
const OPERA_GENRE_RE = /\b(oper|musiktheater|opera)\b/i;
/** Concert-ish markers that override a stray "opera in concert" mention. */
const CONCERT_RE = /konzertant|liederabend|rezital|recital|kammermusik|matinee|gespräch/i;

interface LdEvent {
  name?: string;
  startDate?: string;
  endDate?: string;
  url?: string;
  description?: string;
  about?: { name?: string } | string;
  genre?: string | string[];
  location?: { name?: string } | { name?: string }[] | string;
  workPerformed?: { name?: string; creator?: { name?: string } | { name?: string }[] };
}

export async function scrapeSchwetzingerSwrFestspiele(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    productions.push(...(await scrapeLiveOpera(ctx, window)));
  } catch (err) {
    console.warn("schwetzinger-swr-festspiele: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("schwetzinger-swr-festspiele: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "schwetzinger-swr-festspiele", productions };
}

/** Pull schema.org Events off the programme page, keep the opera ones, group by work. */
async function scrapeLiveOpera(ctx: FetchContext, window: ScrapeWindow): Promise<RawProduction[]> {
  const html = await fetchFirst(ctx, PROGRAMME_URLS);
  if (!html) return [];

  const today = new Date().toISOString().slice(0, 10);
  const byWork = new Map<string, RawProduction>();

  for (const raw of extractEventJsonLd(html) as LdEvent[]) {
    const built = buildFromLd(raw, window, today);
    if (!built) continue;
    const { title, composer, performance, detailUrl } = built;

    const key = title.toLowerCase();
    const existing = byWork.get(key);
    if (existing) {
      existing.performances.push(performance);
      continue;
    }
    byWork.set(key, {
      source_production_id: detailUrl ?? `${key}|${performance.date}`,
      work_title: title,
      composer_name: composer,
      detail_url: detailUrl,
      performances: [performance],
    });
  }

  for (const prod of byWork.values()) {
    prod.performances.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
  }
  return [...byWork.values()];
}

interface BuiltEvent {
  title: string;
  composer: string;
  performance: RawPerformance;
  detailUrl: string | null;
}

function buildFromLd(ev: LdEvent, window: ScrapeWindow, today: string): BuiltEvent | null {
  const start = ev.startDate;
  if (!start) return null;
  const date = start.slice(0, 10) as IsoDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (window.since && date < window.since) return null;

  const work = ev.workPerformed?.name?.trim();
  const title = stripHtml(decodeEntities(work || ev.name || "")).replace(/^\d{4}\s+/, "");
  if (!title) return null;

  const description = stripHtml(decodeEntities(ev.description ?? ""));
  if (!isOpera(ev, title, description)) return null;

  const composer = creatorName(ev) ?? composerFromText(description) ?? composerFromText(title);
  if (!composer) return null;

  const time = timeOf(start);
  return {
    title,
    composer,
    detailUrl: ev.url?.trim() || null,
    performance: {
      date,
      time,
      venue_room: venueOf(ev) ?? ROKOKOTHEATER,
      status: date < today ? "past" : "scheduled",
    },
  };
}

/** Opera signal: an explicit genre/work-type marker, not contradicted by a concert
 *  marker. A bare "von {Composer}" alone is too weak (concerts have composers too). */
function isOpera(ev: LdEvent, title: string, description: string): boolean {
  const about = typeof ev.about === "string" ? ev.about : ev.about?.name;
  const genre = (Array.isArray(ev.genre) ? ev.genre.join(" ") : ev.genre) ?? "";
  const haystack = [genre, about ?? "", title, description].join(" ");
  if (CONCERT_RE.test(haystack)) return false;
  return OPERA_GENRE_RE.test(haystack) || Boolean(ev.workPerformed);
}

function creatorName(ev: LdEvent): string | null {
  const creator = ev.workPerformed?.creator;
  if (!creator) return null;
  const first = Array.isArray(creator) ? creator[0] : creator;
  return first?.name?.trim() || null;
}

function venueOf(ev: LdEvent): string | null {
  const loc = ev.location;
  if (!loc) return null;
  if (typeof loc === "string") return loc.trim() || null;
  const first = Array.isArray(loc) ? loc[0] : loc;
  return first?.name?.trim() || null;
}

/** "2026-04-25T19:00:00+02:00" → "19:00". */
function timeOf(start: string): string | null {
  const m = start.match(/T(\d{2}:\d{2})/);
  return m?.[1] ?? null;
}

/** First programme URL that fetches; the host serves the same content under a few
 *  trailing-slash variants and the path has changed across editions. */
async function fetchFirst(ctx: FetchContext, urls: string[]): Promise<string | null> {
  for (const url of urls) {
    try {
      return await fetchHtml(url, ctx);
    } catch {
      // try the next variant
    }
  }
  return null;
}
