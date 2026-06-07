import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
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
 * Tiroler Landestheater Innsbruck (`json-api` strategy).
 *
 * Tyrol's state theatre — a multi-genre house (Musiktheater / Schauspiel / Tanz /
 * Konzert / Junges Theater) on a Pimcore CMS, with its own opera ensemble.
 * Distinct from the Tiroler Festspiele Erl. The German-language spielplan is a
 * client-rendered JSX widget backed by a JSON endpoint,
 * `/dynamic-search/schedule/j-schedule`, keyed by the page's schedule config id
 * (37802). It returns the announced schedule grouped by local date, one entry per
 * dated *activity*; we narrow to the Musiktheater section (`sectionIds` 30647) via
 * the `sections` filter, then group activities by their stable `productionId` and
 * fetch one detail page per production for the genre line, composer + cast. The
 * home page only links the current teaser repertoire, so it misses early-season
 * operas the feed still carries — the feed is the authoritative discovery source.
 *
 * GENRE FILTER (the opera gate). The Musiktheater section still mixes opera and
 * operetta with musicals, contemporary music-theater, and play-with-music
 * formats. The gate is two-pronged and lives on the detail page's
 * `production__header-description` line (the genre + "von {Composer}" source,
 * e.g. "Operette von Johann Strauss", "Dramma per musica … von Mozart"): keep iff
 * a composer is parseable (`composerFromText`) AND the line is not a musical /
 * musikalischer Monolog / Theaterstück-mit-Musik / revue / Liederabend / concert
 * format. That keeps the wide opera vocabulary the house prints (Oper, Operette,
 * Opéra, Singspiel, Dramma per/giocoso, Melodramma, Comédie héroïque, Familien-/
 * Märchenoper, contemporary "Musiktheater von …") and drops Richard O'Brien's
 * "Musical", a "Musikalischer Monolog" and a "Theaterstück mit Musik".
 *
 * The activity feed only exposes the announced schedule (no deep past archive,
 * and `startDate` range queries error server-side), so the recent-past refresh is
 * whatever already-played dates the feed still carries; backfill appends Wikidata.
 *
 * Per detail page the credit table is `production__cast-role` blocks pairing a
 * `text--label` ("Musikalische Leitung", "Regie", or a sung role) with one or more
 * `<a>` names (alternating casts list several); a label the German credit map
 * knows is a creative function, the rest are sung roles (verbatim fallback).
 */

const BASE = "https://www.landestheater.at";

/** The schedule widget's config id, read off the spielplan page's
 *  `data-schedule-configid`; selects the whole-house schedule feed. */
const SCHEDULE_CONFIG_ID = "37802";

/** The "Musiktheater" section id (`sectionIds`) — the `sections` filter narrows
 *  the feed to opera/operetta-adjacent activities before the per-production gate. */
const MUSIKTHEATER_SECTION_ID = "30647";

/** Tiroler Landestheater Innsbruck on Wikidata — Q125858099 ("Tyrolean state
 *  theater Innsbruck", "Theatre in Innsbruck"). Verified via wbsearchentities
 *  (exact de label match) AND by SPARQL: it carries a premiere via P4647
 *  ("Antikrist", Q1757853), so the QID is the one with backfill data. */
const WIKIDATA_QID = "Q125858099";

/** Non-opera Musiktheater formats to drop even when a composer parses. */
const NON_OPERA_FORMAT_RE =
  /\bmusical\b|musikalischer monolog|theaterstück mit musik|stück mit musik|\brevue\b|liederabend|\bkonzert\b/i;

/** A schedule activity, as the j-schedule feed returns it. */
interface ScheduleActivity {
  productionId: number;
  title: string;
  start: number;
  activityType: string;
  sections: string[];
  stage: string | null;
  production_link: string | null;
  ticketStatus: string | null;
}

interface ScheduleResponse {
  activitiesData?: {
    activities: Record<string, ScheduleActivity[]>;
  };
}

export async function scrapeTirolerLandestheaterInnsbruck(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const activities = await fetchScheduleActivities(ctx);
    for (const group of groupByProduction(activities, window)) {
      try {
        const prod = await buildProduction(group, ctx);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(
          `tiroler-landestheater-innsbruck: production ${group.productionId} failed:`,
          err,
        );
      }
    }
  } catch (err) {
    console.warn("tiroler-landestheater-innsbruck: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("tiroler-landestheater-innsbruck: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "tiroler-landestheater-innsbruck", productions };
}

/**
 * Fetch the whole announced Musiktheater schedule in one request. The feed
 * paginates 25/page, but any page past the last returns the complete set, so we
 * ask for a page far beyond the end and take all of it.
 */
async function fetchScheduleActivities(ctx: FetchContext): Promise<ScheduleActivity[]> {
  const url = `${BASE}/dynamic-search/schedule/j-schedule?configId=${SCHEDULE_CONFIG_ID}&sections=${MUSIKTHEATER_SECTION_ID}&page=999`;
  const data = await fetchJson<ScheduleResponse>(url, ctx);
  return Object.values(data.activitiesData?.activities ?? {}).flat();
}

interface ProductionGroup {
  productionId: string;
  detailUrl: string;
  title: string;
  performances: RawPerformance[];
}

/**
 * Group activities by their stable `productionId`, dropping intro talks
 * ("Einführung", which carry no production performance) and activities outside
 * the Musiktheater section, then collect deduped performances honouring
 * `window.since`. Genre/composer gating happens later, on the detail page.
 */
function groupByProduction(
  activities: ScheduleActivity[],
  window: ScrapeWindow,
): ProductionGroup[] {
  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map<string, ProductionGroup>();
  const seenPerf = new Set<string>();

  for (const act of activities) {
    if (!act.sections?.includes("Musiktheater")) continue;
    if (/einführung/i.test(act.activityType)) continue;
    if (!act.production_link) continue;

    const { date, time } = viennaDateTime(act.start);
    if (window.since && date < window.since) continue;

    const productionId = String(act.productionId);
    let group = groups.get(productionId);
    if (!group) {
      group = {
        productionId,
        detailUrl: `${BASE}${act.production_link}`,
        title: decodeEntities(act.title).trim(),
        performances: [],
      };
      groups.set(productionId, group);
    }

    const key = `${productionId}|${date}|${time ?? ""}`;
    if (seenPerf.has(key)) continue;
    seenPerf.add(key);

    group.performances.push({
      date,
      time,
      venue_room: act.stage ? decodeEntities(act.stage).trim() : null,
      status: act.ticketStatus === "cancelled" ? "cancelled" : date < today ? "past" : "scheduled",
    });
  }

  return [...groups.values()].filter((g) => g.performances.length > 0);
}

/**
 * Build a production from its group + detail page: the genre/composer gate, then
 * the cast + creative team. Returns null when no composer parses (not opera) or
 * the genre line is a non-opera format (musical, etc.).
 */
async function buildProduction(
  group: ProductionGroup,
  ctx: FetchContext,
): Promise<RawProduction | null> {
  const html = await fetchHtml(group.detailUrl, ctx);

  const genreRegion = parseGenreRegion(html);
  if (NON_OPERA_FORMAT_RE.test(genreRegion)) return null;
  const composer = composerFromText(composerHead(genreRegion));
  if (!composer) return null;

  group.performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  const { creative_team, cast } = parseCredits(html);
  return {
    source_production_id: `tiroler-landestheater-innsbruck/${group.productionId}`,
    work_title: group.title,
    composer_name: composer,
    detail_url: group.detailUrl,
    creative_team,
    cast,
    performances: group.performances,
  };
}

/**
 * The genre + composer text: the `production__header-description` block plus any
 * following `header-row` paragraphs up to the age tag. This whole region is what
 * the non-opera-format gate reads (so a "Theaterstück mit Musik von …" line is
 * still recognised as a play even though it names a composer).
 */
function parseGenreRegion(html: string): string {
  const i = html.indexOf("production__header-description");
  if (i < 0) return "";
  const beforeAge = html.slice(i, i + 900).split(/production__header-age\b/)[0] ?? "";
  return stripHtml(beforeAge).trim();
}

/**
 * The clean "{genre} von {Name}" head for `composerFromText`. When the leading
 * "von" names a librettist (operetta/Singspiel), the composer sits in a separate
 * "Musik von {Composer}" clause the description-line trim would drop, so prefer
 * that clause; otherwise trim the language/Libretto/secondary-genre noise.
 */
function composerHead(region: string): string {
  const musik = region.match(/Musik von [^.]+/i);
  if (musik) return musik[0];
  return (
    region.split(
      /\bLibretto\b|\bGesangstexte\b|\bIn (?:deutscher|italien|franz|englisch)|\bFamilienoper\b|\bMärchenoper\b|Empfohlen|\bab \d+ Jahren|Großes Haus|Kammerspiele|Foyer/i,
    )[0] ?? ""
  );
}

const CAST_ROLE_RE =
  /<div class="production__cast-role">\s*<span class="text text--label">([\s\S]*?)<\/span>\s*<span class="production__cast-role-names">([\s\S]*?)<\/span>\s*<\/div>/g;
const NAME_ANCHOR_RE = /<a\b[^>]*>([\s\S]*?)<\/a>/g;

/**
 * Cast + creative team from the `production__cast-role` blocks: a `text--label`
 * + one or more `<a>` names. A label the German credit map knows is a creative
 * function ("Musikalische Leitung" → conductor); the rest are sung roles.
 * Ensemble rows (orchestra/chorus, no person link) yield no `<a>` and are
 * skipped. Deduped on function|name / role|name.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, rawLabel, rawNames] of matchAllPair(html, CAST_ROLE_RE)) {
    const label = stripHtml(rawLabel);
    if (!label) continue;

    for (const [, rawName] of matchAllSingle(rawNames, NAME_ANCHOR_RE)) {
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

const VIENNA_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Vienna",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** A feed `start` is a unix timestamp; render the local Innsbruck date + time so
 *  DST is handled rather than a fixed offset. */
function viennaDateTime(start: number): { date: IsoDate; time: string | null } {
  const parts = VIENNA_PARTS.formatToParts(new Date(start * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}` as IsoDate;
  const hour = get("hour") === "24" ? "00" : get("hour");
  const time = hour && get("minute") ? `${hour}:${get("minute")}` : null;
  return { date, time };
}

/** matchAll wrapper yielding [full, g1] tuples — keeps adapters regex-only, no eval. */
function* matchAllSingle(html: string, re: RegExp): Generator<[string, string]> {
  for (const m of html.matchAll(re)) yield [m[0], m[1] ?? ""];
}

/** matchAll wrapper yielding [full, g1, g2] tuples for the cast-role regex. */
function* matchAllPair(html: string, re: RegExp): Generator<[string, string, string]> {
  for (const m of html.matchAll(re)) yield [m[0], m[1] ?? "", m[2] ?? ""];
}
