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
 * Maggio Musicale Fiorentino, Florence (`json-api` strategy, Strapi v4 backend).
 *
 * FESTIVAL — the spring/summer arts festival of the Teatro del Maggio (Opera di
 * Firenze). It mixes a major staged-opera strand with concerts, dance, recitals
 * and outreach, so the live leg is opera-only: the Nuxt frontend is fed by a
 * Strapi collection at `/api/events` that returns every event (2018→) fully
 * populated in one call — categories, the `recita[]` performance list, the
 * composer in `subtitle`, and credits/cast as HTML. We keep an event only when
 * its `event_categories` carries the "Opera" tag (Strapi's own taxonomy already
 * separates Concerti / Danza / Balletto / Recital / Maggio aperto), it isn't a
 * concert-form ("in forma di concerto") billing, AND we can resolve a composer —
 * that drops the few opera-tagged taglines with no byline.
 *
 * Performances come from `recita[]` (one row per night: `date_start`,
 * `time_start`, `location` = venue, e.g. Teatro del Maggio - Sala Grande / Sala
 * Zubin Mehta); archival events predating the ticketing list fall back to a
 * single performance from `datetime_start`. Composer is the `subtitle` field
 * (cleaned: "Composer - Work" → composer, "Dall'opera … di {X}" → {X},
 * double-bills "Bartók / Poulenc" kept verbatim). Credits are `<p><span>Label
 * </span><br>Name</p>` rows: the Italian function labels in `artists` map to
 * canonical keys below, the role→singer rows in `artists_more` are the cast.
 *
 * Because the single API call already carries the full archive, the window only
 * gates which performances are emitted: incremental keeps the future plus a
 * rolling recent-past refresh; backfill keeps everything back to `window.since`
 * and appends Wikidata for the deeper history the ticketing data doesn't reach.
 */

const EVENTS_API = "https://www.maggiofiorentino.com/api/events";
/** Maggio Musicale Fiorentino on Wikidata — verified via wbsearchentities:
 *  P31 = annual music festival (Q28057350), P136 genre = opera (Q1344), P17 =
 *  Italy, inception 1933. The festival entity, not a building. */
const WIKIDATA_QID = "Q954628";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/** Italian creative-function labels → canonical function keys, tested in order.
 *  Any label mentioning "regia" is a director credit first (the site combines it:
 *  "Regia e scene"), so it precedes the set/costume rules. */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro/i, "chorus-master"],
  [/direttore|maestro concertatore|direzione musicale/i, "conductor"],
  [/regia/i, "director"],
  [/coreograf/i, "choreographer"],
  [/disegno luci|^luci\b|^luce\b/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi/i, "costume-designer"],
  [/scenografia|^scene\b/i, "set-designer"],
  [/drammaturgia/i, "dramaturgy"],
];

interface Recita {
  date_start?: string | null;
  time_start?: string | null;
  location?: string | null;
}

interface MmfEvent {
  id: number;
  name?: string | null;
  slug?: string | null;
  subtitle?: string | null;
  artists?: string | null;
  artists_more?: string | null;
  datetime_start?: string | null;
  soldout?: boolean | null;
  event_categories?: { name?: string | null }[] | null;
  recita?: Recita[] | null;
}

export async function scrapeMaggioMusicaleFiorentino(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const { data } = await fetchJson<{ data: MmfEvent[] }>(EVENTS_API, ctx);
    const since = effectiveSince(window);

    for (const event of data) {
      try {
        const prod = buildProduction(event, since);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`maggio-musicale-fiorentino: ${event.slug ?? event.id} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("maggio-musicale-fiorentino: events API scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("maggio-musicale-fiorentino: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "maggio-musicale-fiorentino", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

function buildProduction(event: MmfEvent, since: IsoDate | null): RawProduction | null {
  const categories = (event.event_categories ?? []).map((c) => (c.name ?? "").toLowerCase());
  if (!categories.includes("opera")) return null;

  const title = stripHtml(event.name ?? "").trim();
  if (!title) return null;
  // Concert-form ("in forma di concerto") operas are sung, not staged — drop them.
  if (/in forma di concerto/i.test(title)) return null;

  const composer = parseComposer(event.subtitle ?? "", title);
  if (!composer) return null;

  const performances = parsePerformances(event, since);
  if (performances.length === 0) return null;

  return {
    source_production_id: event.slug ?? String(event.id),
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: event.slug ? `https://www.maggiofiorentino.com/events/${event.slug}` : null,
    creative_team: parseCredits(event.artists ?? ""),
    cast: parseCast(event.artists_more ?? ""),
    performances,
  };
}

/**
 * `subtitle` carries the composer byline, with several shapes:
 *   - "Giuseppe Verdi"                          → as-is
 *   - "Béla Bartók / Francis Poulenc"           → kept verbatim (double bill)
 *   - "Giacomo Puccini - Gianni Schicchi"       → composer is before " - "
 *   - "Dittico - Igor Stravinskij/Giacomo Puccini" → a form word ("Dittico")
 *       precedes the dash; the composers are after it
 *   - "Dall'opera 'Rigoletto' di Giuseppe Verdi" → take after " di "
 * When the subtitle is a tagline (a guest city on a tournée billing, a school
 * concert's programme line), the composer instead sits in the `name` field as
 * "Composer - Work"; we fall back to that. Anything that still resolves to no
 * recognizable name yields null, and the event is dropped (composer required).
 */
function parseComposer(subtitleRaw: string, name: string): string | null {
  // The subtitle is the byline field, so a bare composer name there is trusted.
  // The name field is only a fallback for tournée/school billings whose subtitle
  // is a tagline, and only when it's explicitly "Composer - Work" shaped — a bare
  // two-word title ("Verdi Game") must not be misread as a composer.
  return composerFromByline(subtitleRaw, true) ?? composerFromByline(name, false);
}

/** Resolve a "Composer …" / "{form} - Composer" / "Dall'opera … di Composer"
 *  byline to its composer(s), or null when no person name is present.
 *  `allowBare` permits a dashless name to be taken whole (subtitle only). */
function composerFromByline(raw: string, allowBare: boolean): string | null {
  const text = decodeEntities(stripHtml(raw)).trim();
  if (!text) return null;

  const fromOpera = text.match(/dall'?opera\b.*?\bdi\s+(.+)$/i);
  if (fromOpera?.[1]) return cleanName(fromOpera[1]);

  // A " - " splits a form/work label from the composer byline; the composer is
  // whichever side reads as a name ("Puccini - Gianni Schicchi" → left,
  // "Dittico - Stravinskij/Puccini" → right). Otherwise treat the whole as one.
  const dashed = text.split(/\s+[-–]\s+/).map((s) => s.trim());
  if (dashed.length > 1) {
    const named = dashed.find(looksLikePersonName);
    return named ? cleanName(named) : null;
  }

  return allowBare && looksLikePersonName(text) ? cleanName(text) : null;
}

const FORM_WORDS =
  /\b(opera|dittico|trittico|sinfonia|sinfonie|quinta|quarta|recita|spettacolo|concerto|festival)\b/i;

/** A composer byline is one-or-more capitalized name tokens (allowing "/" double
 *  bills); a tagline ("Tutto nel mondo è burla", "La Sinfonia K. 550 di Mozart…")
 *  reads as a sentence — reject segments carrying lowercase connectives or known
 *  form words, and require a leading capitalized word per "/"-segment. */
function looksLikePersonName(text: string): boolean {
  const segments = text.split(/\s*\/\s*/).map((s) => s.trim());
  return segments.every(
    (seg) =>
      /^[A-ZÀ-Ý][a-zà-ÿ.'’-]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ.'’-]+){0,3}$/.test(seg) && !FORM_WORDS.test(seg),
  );
}

function cleanName(text: string): string {
  return decodeEntities(stripHtml(text)).replace(/\s+/g, " ").trim();
}

/** Performances from `recita[]` (one per night), or a single fallback from
 *  `datetime_start` for archival events that predate the ticketing list. */
function parsePerformances(event: MmfEvent, since: IsoDate | null): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const emit = (dateRaw: string, timeRaw: string | null, venue: string | null): void => {
    const date = dateRaw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (since && date < since) return;
    const time = timeRaw?.match(/^(\d{1,2}):(\d{2})/);
    const hhmm = time ? `${time[1]?.padStart(2, "0")}:${time[2]}` : null;
    const key = `${date}|${hhmm}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      date: date as IsoDate,
      time: hhmm,
      venue_room: venue ? stripHtml(venue).trim() || null : null,
      status: event.soldout ? "sold_out" : date < today ? "past" : "scheduled",
    });
  };

  const recite = event.recita ?? [];
  if (recite.length > 0) {
    for (const r of recite)
      if (r.date_start) emit(r.date_start, r.time_start ?? null, r.location ?? null);
  } else if (event.datetime_start) {
    const [d, t] = event.datetime_start.split(" ");
    if (d) emit(d, t ?? null, null);
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/** Creative team: `<p><span style="color:#808080;">Label</span><br>Name</p>`
 *  rows in `artists` whose Italian label maps to a canonical function. Ensemble
 *  lines (Orchestra e Coro …) have no label span and are skipped. */
function parseCredits(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const { label, name } of labelRows(html)) {
    const fn = mapFunction(label);
    if (!fn) continue;
    for (const person of splitNames(name)) {
      const key = `${fn}|${person}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ function: fn, name: person });
    }
  }
  return out;
}

/** Cast: the same row shape in `artists_more`, where the label is a sung
 *  character role and the value the singer. A row whose label is itself a staff
 *  function (a chorus master listed among the cast) goes to the creative side is
 *  rare here; we keep cast rows as printed. */
function parseCast(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  for (const { label, name } of labelRows(html)) {
    if (mapFunction(label)) continue;
    for (const person of splitNames(name)) out.push({ role: label, name: person });
  }
  return out;
}

/** Parse `<p><span …>Label</span><br>[<span>]Name</p>` rows into label/name pairs. */
function labelRows(html: string): { label: string; name: string }[] {
  const rows: { label: string; name: string }[] = [];
  const re = /<p>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<br\s*\/?>\s*([\s\S]*?)<\/p>/gi;
  for (const [, rawLabel, rawName] of html.matchAll(re)) {
    const label = decodeEntities(stripHtml(rawLabel ?? ""))
      .replace(/[:.]\s*$/, "")
      .trim();
    const name = decodeEntities(stripHtml(rawName ?? "")).trim();
    if (label && name) rows.push({ label, name });
  }
  return rows;
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A credit value may list several people; split on commas / " e ". Drop ensemble
 *  names (orchestra, coro) — they aren't individual performers we model. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+e\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s));
}

/** Festival editions run within a calendar year (spring/summer); use the year. */
function seasonOf(date: IsoDate | null | undefined): string | null {
  return date ? date.slice(0, 4) : null;
}
