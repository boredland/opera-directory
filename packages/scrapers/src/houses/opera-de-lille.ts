import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Opéra de Lille (`spielplan-html` strategy). The WordPress REST API is locked
 * (401), so the season is read from two HTML surfaces:
 *   - the site-wide `/calendrier/` widget is the discovery + genre gate + the
 *     only year-accurate per-night date source. Each performance is a
 *     `calendrier-YYYY-MM-DD` container holding a `date-line-link` to its
 *     `/spectacle/<slug>/` and a `date-line-categorie` (the genre). We keep the
 *     slugs whose genre is opera ("opéra" / "opéra itinérant") and collect their
 *     ISO nights — the detail page prints day+month only, so the calendar's full
 *     dates are what carry the year across a season boundary.
 *   - each opera's `/spectacle/<slug>/` detail page (current "sHeader" template):
 *       - genre re-confirmed via `sHeader_catItem`;
 *       - title = `sHeader_title`;
 *       - composer = the "Opéra … de <strong>…</strong>" byline opening the
 *         distribution, else the "opéra … de …" `sHeader_infos` byline. Requiring
 *         the byline to start with "Opéra" doubles as the opera gate — a recital
 *         ("Concert théâtralisé …") yields no composer and is dropped;
 *       - creative team + cast = the `section_content` distribution paragraphs:
 *         a creative credit is `Label <strong>Name</strong>`; a cast credit is
 *         `<strong>Name</strong> Role`, in the paragraph that opens with "Avec";
 *       - per-night times come from the `spectacle-details-date` /
 *         `spectacle-details-heure` rows, matched onto the calendar nights by
 *         month+day.
 *
 * The calendar is forward-looking only (the house drops played nights), so the
 * live adapter sees the announced future; the deep past comes from Wikidata
 * (Q3354558) in backfill mode — Lille's 57 P4647/P272 works are the richest of
 * the French set.
 */

const BASE = "https://www.opera-lille.fr";
const CALENDAR_URL = `${BASE}/calendrier/`;
const VENUE = "Opéra de Lille";
/** Opéra de Lille — verified via wbsearchentities: Q3354558, P17 = France. */
const WIKIDATA_QID = "Q3354558";

const RECENT_PAST_DAYS = 45;

const MONTHS: Record<string, string> = {
  janvier: "01",
  février: "02",
  fevrier: "02",
  mars: "03",
  avril: "04",
  mai: "05",
  juin: "06",
  juillet: "07",
  août: "08",
  aout: "08",
  septembre: "09",
  octobre: "10",
  novembre: "11",
  décembre: "12",
  decembre: "12",
};

/** French creative-function labels → canonical function keys, tested in order. */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/chef?fe?\s+de\s+ch[œoe]ur|direction\s+du\s+ch[œoe]ur/i, "chorus-master"],
  [/chef?fe?\s+de\s+chant/i, "repetiteur"],
  [/direction\s+musicale|chef?fe?\s+d['’]orchestre/i, "conductor"],
  [/mise?\s+en\s+sc[èe]ne/i, "director"],
  [/chor[ée]graph/i, "choreographer"],
  [/lumi[èe]res?|[ée]clairages?/i, "lighting"],
  [/sc[ée]nographie|d[ée]cors?/i, "set-designer"],
  [/costumes?/i, "costume-designer"],
  [/dramaturg/i, "dramaturgy"],
  [/vid[ée]o/i, "video"],
];

/** Lines in the cast paragraph that are an ensemble, not a sung character. */
const ENSEMBLE = /orchestre|ch[œoe]ur|ensemble|ballet|ma[îi]trise|danse/i;

interface CalendarShow {
  slug: string;
  isoDates: Set<string>;
}

export async function scrapeOperaDeLille(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);
    const calendar = parseCalendar(await fetchHtml(CALENDAR_URL, ctx));
    for (const show of calendar) {
      const prod = await buildProduction(show, ctx, since, today);
      if (prod) productions.push(prod);
    }
  } catch (err) {
    console.warn("opera-de-lille: calendar scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opera-de-lille: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "opera-de-lille", productions };
}

function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/**
 * The calendar widget, reduced to one entry per opera production. Each
 * `calendrier-YYYY-MM-DD` container is a single night; we attribute it to the
 * first `date-line` it holds and keep only the opera genres.
 */
function parseCalendar(html: string): CalendarShow[] {
  const shows = new Map<string, CalendarShow>();
  const re =
    /calendrier-(\d{4}-\d{2}-\d{2})">([\s\S]*?)(?=<div class="calendrier-dates"|<div class="calendrier-mois"|$)/g;
  for (const m of html.matchAll(re)) {
    const iso = m[1] as string;
    const line = /\/spectacle\/([^/"]+)\/"[\s\S]*?date-line-categorie"><span>([^<]+)<\/span>/.exec(
      m[2] ?? "",
    );
    if (!line) continue;
    const slug = line[1] as string;
    const genre = decodeEntities(line[2] ?? "").toLowerCase();
    if (!/op[ée]ra/.test(genre)) continue;
    const show = shows.get(slug) ?? { slug, isoDates: new Set<string>() };
    show.isoDates.add(iso);
    shows.set(slug, show);
  }
  return [...shows.values()];
}

async function buildProduction(
  show: CalendarShow,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  let html: string;
  try {
    html = await fetchHtml(`${BASE}/spectacle/${show.slug}/`, ctx);
  } catch (err) {
    console.warn(`opera-de-lille: detail fetch failed for ${show.slug}:`, err);
    return null;
  }

  const genre = extract(html, /sHeader_catItem">\s*([^<]+?)\s*</);
  if (!genre || !/op[ée]ra/i.test(genre)) return null; // genre gate

  const title = cleanText(extract(html, /sHeader_title">\s*([\s\S]*?)<\/h1>/) ?? "");
  if (!title) return null;

  const block = distributionBlock(html);
  const composer = parseComposer(html, block);
  if (!composer) return null; // opera gate — a recital/concert has no "Opéra … de" byline

  const dist = parseDistribution(block);
  const times = parseTimes(html);
  const performances = buildPerformances(show.isoDates, times, since, today);
  if (performances.length === 0) return null;

  return {
    source_production_id: show.slug,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: `${BASE}/spectacle/${show.slug}/`,
    creative_team: dist.creative,
    cast: dist.cast,
    performances,
  };
}

/** The `section_content` distribution block, anchored to the "Distribution" heading. */
function distributionBlock(html: string): string | null {
  return extract(
    html,
    /section_headerTitle">\s*Distribution\s*<\/h2>[\s\S]*?section_content">([\s\S]*?)<\/section>/,
  );
}

/**
 * Composer = the "Opéra … de <strong>Name</strong>" byline that opens the
 * distribution (or, failing that, the `sHeader_infos` line). Requiring the byline
 * to START with "Opéra" is also the opera gate: a recital/concert opens with
 * "Concert théâtralisé …" / a bare performer name, so it yields no composer and
 * is dropped. Trailing life-dates ("(1685-1759)") are trimmed.
 */
function parseComposer(html: string, block: string | null): string | null {
  const firstParagraph = block ? /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] : null;
  if (firstParagraph && /^\s*op[ée]ra/i.test(cleanText(firstParagraph))) {
    const name = cleanText(
      extract(firstParagraph, /<strong>\s*([^<(]+?)\s*(?:\(|<\/strong>)/) ?? "",
    );
    if (name) return name;
  }

  const infos = cleanText(extract(html, /sHeader_infos[^>]*>\s*([\s\S]*?)(?:<br|<\/p>)/i) ?? "");
  if (/^op[ée]ra\b/i.test(infos)) {
    const name = infos.replace(/^op[ée]ra(?:[\s-][a-zà-ÿ]+)?\s+d(?:e\s+|['’])/i, "");
    if (name && name !== infos && name.length <= 80) return name;
  }
  return null;
}

interface Distribution {
  creative: RawCredit[];
  cast: RawCredit[];
}

/**
 * Creative team + cast from the distribution `<p>` paragraphs: the one opening
 * with "Avec" is the cast (each line `<strong>Name</strong> Role`, the role
 * sometimes absent), the others carry creative credits (each line
 * `Label <strong>Name</strong>`), with the leading "Opéra de … / Livret …"
 * paragraph naturally yielding no mappable label.
 */
function parseDistribution(block: string | null): Distribution {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  if (!block) return { creative, cast };

  for (const p of block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const inner = p[1] ?? "";
    if (/^\s*(?:<[^>]+>\s*)*avec\b/i.test(inner)) {
      for (const line of splitLines(inner)) {
        const m = /<strong>\s*([^<]+?)\s*<\/strong>\s*([^<]*)/.exec(line);
        if (!m) continue;
        const name = cleanText(m[1] ?? "");
        const role = cleanText(m[2] ?? "") || null;
        if (name && !ENSEMBLE.test(name) && !(role && ENSEMBLE.test(role))) {
          cast.push({ role, name });
        }
      }
    } else {
      for (const line of splitLines(inner)) {
        const m = /^([^<]+?)\s*<strong>\s*([^<]+?)\s*<\/strong>/.exec(line);
        if (!m) continue;
        const fn = mapLabel(cleanText(m[1] ?? ""));
        if (!fn) continue;
        for (const name of splitNames(cleanText(m[2] ?? ""))) creative.push({ function: fn, name });
      }
    }
  }
  return { creative, cast };
}

/** A month+day → `HH:MM` map from the `spectacle-details-date`/`-heure` rows. */
function parseTimes(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /spectacle-details-date">\s*([^<]+?)\s*<\/span>\s*<span class="spectacle-details-heure">\s*([^<]+?)\s*</g;
  for (const m of html.matchAll(re)) {
    const md = monthDay(m[1] ?? "");
    const time = parseTime(m[2] ?? "");
    if (md && time) out.set(md, time);
  }
  return out;
}

function buildPerformances(
  isoDates: Set<string>,
  times: Map<string, string>,
  since: IsoDate | null,
  today: string,
): RawPerformance[] {
  const out: RawPerformance[] = [];
  for (const date of [...isoDates].sort()) {
    if (since && date < since) continue;
    out.push({
      date: date as IsoDate,
      time: times.get(date.slice(5)) ?? null,
      venue_room: VENUE,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out;
}

/** "Mardi 6 octobre 2027" / "07 mai" → "MM-DD" to key against the calendar nights. */
function monthDay(label: string): string | null {
  const m = /(\d{1,2})\s+([a-zàâäéèêëîïôöûüç]+)/i.exec(label.toLowerCase());
  if (!m) return null;
  const mm = MONTHS[m[2] as string];
  if (!mm) return null;
  return `${mm}-${(m[1] as string).padStart(2, "0")}`;
}

/** "19h30" → "19:30"; "20h" → "20:00". */
function parseTime(raw: string): string | null {
  const m = /(\d{1,2})\s*h\s*(\d{2})?/i.exec(raw);
  if (!m) return null;
  return `${(m[1] as string).padStart(2, "0")}:${m[2] ?? "00"}`;
}

/** Distribution lines are `<br>`-separated within a paragraph. */
function splitLines(html: string): string[] {
  return html
    .split(/<br\s*\/?>/i)
    .map((s) => s.trim())
    .filter(Boolean);
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

function extract(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m?.[1] ?? null;
}

function cleanText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/[:–-]\s*$/, "")
    .trim();
}

function seasonOf(date?: IsoDate): string | null {
  if (!date) return null;
  const [y, m] = date.split("-").map(Number) as [number, number];
  const start = m >= 8 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}
