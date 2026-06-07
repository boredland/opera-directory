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
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Oper Graz / Graz Opera (Bühnen Graz, Graz, Austria) — `spielplan-html`.
 *
 * German-language WordPress site (oper-graz.buehnen-graz.com). The whole
 * announced season lives on ONE server-rendered page, the calendar at
 * `/spielplan/kalender/`: every performance is an `<article class="event …
 * event-cat-{genre}">` carrying its genre, work title (`<h3>`), composer
 * (`sub__title`), a `<p class="data">` with "Wd. DD.MM.YYYY <br> HH:MM bis … <br>
 * {venue}", a `vorstellungsId` ticket link, and a `contibutors-list` of
 * "<span>{Label}:</span> <a>{Name}</a>" pairs (creative team + sung cast mixed).
 * No Event JSON-LD and the `/produktion/{slug}/` detail pages render their cast
 * client-side, so the calendar is the single complete source. We keep
 * `event-cat-oper` / `event-cat-operette` (the OPERA GATE) and drop musical,
 * ballett, konzert, gastspiel and the rest, then group the per-night articles by
 * production slug. The calendar only lists the future, so the past comes from the
 * Wikidata backfill.
 */

const BASE = "https://oper-graz.buehnen-graz.com";
const CALENDAR_URL = `${BASE}/spielplan/kalender/`;
/** Graz Opera on Wikidata — Q618239 ("opera house in Graz, Styria, Austria").
 *  Verified via wbsearchentities (alias "Oper Graz"/"Opernhaus Graz") and by
 *  SPARQL: this house record carries 6 productions via P4647/P272, whereas the
 *  separate company record Q113484903 carries only 1, so the house QID is the
 *  one with backfill data. */
const WIKIDATA_QID = "Q618239";

/** event-cat-{genre} values that are staged opera/operetta. */
const OPERA_CATEGORIES = new Set(["oper", "operette"]);

interface ProductionGroup {
  slug: string;
  title: string;
  composer: string | null;
  performances: RawPerformance[];
  creative: RawCredit[];
  cast: RawCredit[];
}

export async function scrapeOperGraz(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const html = await fetchHtml(CALENDAR_URL, ctx);
    for (const group of groupBySlug(html, window).values()) {
      const prod = toProduction(group);
      if (prod) productions.push(prod);
    }
  } catch (err) {
    console.warn("oper-graz: calendar fetch failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("oper-graz: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "oper-graz", productions };
}

/**
 * Parse every `<article class="event … event-cat-{genre}">` on the calendar,
 * keep the opera/operetta ones, and group their per-night data by production
 * slug. The contributors list repeats per night, so it's collected once from the
 * first article that carries it for a slug.
 */
function groupBySlug(html: string, window: ScrapeWindow): Map<string, ProductionGroup> {
  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map<string, ProductionGroup>();

  const articleRe = /<article\b[^>]*class="(event[^"]*)"[^>]*>([\s\S]*?)<\/article>/g;
  for (const [, cls, body] of html.matchAll(articleRe)) {
    const category = cls?.match(/event-cat-([a-z-]+)/)?.[1];
    if (!category || !OPERA_CATEGORIES.has(category)) continue;

    const slug = body?.match(/\/produktion\/([a-z0-9-]+)\//)?.[1];
    const title = stripHtml(body?.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? "");
    if (!slug || !title) continue;

    const perf = parsePerformance(body ?? "", today, window);

    let group = groups.get(slug);
    if (!group) {
      group = {
        slug,
        title,
        composer: parseComposer(body ?? ""),
        performances: [],
        creative: [],
        cast: [],
      };
      groups.set(slug, group);
    }
    if (perf) group.performances.push(perf);
    if (group.creative.length === 0 && group.cast.length === 0) {
      const { creative, cast } = parseContributors(body ?? "");
      group.creative = creative;
      group.cast = cast;
    }
  }

  return groups;
}

/** `sub__title` carries the composer verbatim (e.g. "Giuseppe Verdi"). */
function parseComposer(body: string): string | null {
  const name = stripHtml(body.match(/sub__title">([\s\S]*?)<\/p>/)?.[1] ?? "");
  return name.length >= 3 && name.length <= 60 ? name : null;
}

/**
 * `<p class="data"><b> Wd. DD.MM.YYYY <br> HH:MM bis … <br> {venue} </b>`. The
 * weekday prefix is stripped; the second line's start time becomes `time`; the
 * trailing line is the room. Status is derived from the date (the calendar lists
 * the future, ticket state isn't in the SSR DOM).
 */
function parsePerformance(
  body: string,
  today: string,
  window: ScrapeWindow,
): RawPerformance | null {
  const block = stripHtml(body.match(/<p class="data"><b>([\s\S]*?)<\/b>/)?.[1] ?? "");
  if (!block) return null;

  const dm = block.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!dm) return null;
  const date = `${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
  if (window.since && date < window.since) return null;

  const time = block.match(/(\d{1,2}:\d{2})/)?.[1]?.padStart(5, "0") ?? null;
  const venue =
    block
      .replace(/.*Uhr|.*bis\s+ca\.\s+\d{1,2}:\d{2}|.*\d{1,2}:\d{2}/s, "")
      .replace(/\d{2}\.\d{2}\.\d{4}/, "")
      .trim() || null;

  return {
    date,
    time,
    venue_room: venue,
    status: date < today ? "past" : "scheduled",
  };
}

/**
 * `contibutors-list`: "<li><span>{Label}:</span> <a>{Name}</a></li>". A label
 * the German credit map knows is a creative function; the rest are sung roles
 * (verbatim fallback). Deduped within a production.
 */
function parseContributors(body: string): { creative: RawCredit[]; cast: RawCredit[] } {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  const re = /<li><span>([^<]*?):?<\/span>\s*<a[^>]*>([\s\S]*?)<\/a>/g;
  for (const [, rawLabel, rawName] of body.matchAll(re)) {
    const label = decodeEntities(rawLabel ?? "")
      .replace(/:\s*$/, "")
      .trim();
    const name = stripHtml(rawName ?? "");
    if (!label || !name) continue;

    const key = `${label}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative.push(credit);
    else cast.push(credit);
  }

  return { creative, cast };
}

function toProduction(group: ProductionGroup): RawProduction | null {
  if (!group.composer) return null;

  const seen = new Set<string>();
  const performances = group.performances
    .filter((p) => {
      const key = `${p.date}|${p.time ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  if (performances.length === 0) return null;

  return {
    source_production_id: `oper-graz/${group.slug}`,
    work_title: group.title,
    composer_name: group.composer,
    detail_url: `${BASE}/produktion/${group.slug}/`,
    creative_team: group.creative,
    cast: group.cast,
    performances,
  };
}
