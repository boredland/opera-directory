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
 * Wiener Volksoper / Vienna Volksoper (`spielplan-html` strategy).
 *
 * Vienna's second house — opera, operetta, musical and ballet under one roof.
 * The site is German-language SSR HTML (a TYPO3 backend behind a Next.js shell):
 * no schema.org Event JSON-LD and no public JSON API, but the spielplan emits
 * schema.org microdata one `<article class="event-list-item">` per dated
 * performance, carrying title, a genre+composer line (`event-description`,
 * e.g. "Operette von Emmerich Kálmán"), the date (`<time datetime>`), an ISO
 * `startDate` (time + tz), the venue, the production detail URL, and a stable
 * `filter[production]` id. We group those flat rows by production id, gate, then
 * fetch one detail page per kept production for the cast + creative team.
 *
 * GENRE FILTER (the opera gate). The house mixes Oper/Operette/Musical/Ballett/
 * Konzert/Kinder; we keep only opera + operetta. The `event-description` is both
 * the genre token and the composer source, so the gate is two-pronged and lives
 * entirely on the cheap spielplan row: keep iff the description names the genre
 * "Oper"/"Operette" AND a composer is parseable (`composerFromText`) AND it is
 * not a Musical/Ballett/Konzert/Kinder format. That drops musicals
 * ("Musical von …"), ballets, concerts ("… kammermusikalisch", "Liederabend",
 * "Abschlusskonzert"), plays-with-music ("Ein Stück mit Musik von …"), and
 * concert-hybrid double bills (the Requiem half of a "KaiserRequiem" evening),
 * none of which read as Oper/Operette.
 *
 * Discovery is the season spielplan. Incremental reads `/spielplan/` (the full
 * announced future of the current season) plus the recent past via month pages.
 * Backfill walks `/spielplan/{month}-{year}.de.html` backward (the archive
 * reaches ~2019; pandemic months 404/500), bounded by `window.since`, then
 * appends Wikidata.
 *
 * Per detail page the credit table is `<dt class="role">{label}</dt>
 * <dd class="name">{name}</dd>` pairs; a label the German credit map knows
 * ("Musikalische Leitung", "Inszenierung") is a creative function, the rest are
 * sung roles (verbatim fallback).
 */

const BASE = "https://www.volksoper.at";

/** Vienna Volksoper on Wikidata — Q694747 ("Vienna Volksoper", "building in
 *  Vienna, Austria"). Verified via wbsearchentities AND by SPARQL: it carries 4
 *  productions via P4647/P272, whereas the separate "theatre company" record
 *  Q113070627 carries 0 — so the building QID is the one with backfill data. */
const WIKIDATA_QID = "Q694747";

const VENUE = "Wiener Volksoper";

/** How far back the backfill month walk reaches; the live archive thins out
 *  around 2019 and pandemic months error, so this is a generous cap. */
const MAX_BACKFILL_MONTHS = 120;

/** German month slugs (incl. the Austrian "jänner") used in the month URLs. */
const MONTH_SLUGS = [
  "jänner",
  "februar",
  "märz",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "dezember",
];

/** A spielplan row, pre-grouping. One per dated performance. */
interface EventRow {
  productionId: string;
  detailUrl: string;
  title: string;
  description: string;
  date: IsoDate;
  time: string | null;
  venue: string;
}

export async function scrapeWienerVolksoper(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const rows = await collectRows(ctx, window);
    const grouped = groupByProduction(rows, window);
    for (const group of grouped) {
      try {
        const prod = await buildProduction(group, ctx);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`wiener-volksoper: production ${group.productionId} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("wiener-volksoper: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("wiener-volksoper: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "wiener-volksoper", productions };
}

/**
 * Collect spielplan event rows. Incremental: the season `/spielplan/` (full
 * announced future) plus the current + two prior months for the recent-past
 * refresh. Backfill: walk month pages backward to `window.since`.
 */
async function collectRows(ctx: FetchContext, window: ScrapeWindow): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  const now = new Date();

  if (window.mode === "backfill") {
    for (let hop = 0; hop < MAX_BACKFILL_MONTHS; hop++) {
      const d = new Date(now.getFullYear(), now.getMonth() - hop, 1);
      const monthEndDate = monthEnd(d.getFullYear(), d.getMonth() + 1);
      if (window.since && monthEndDate < window.since) break;
      const html = await fetchMonth(ctx, d.getFullYear(), d.getMonth() + 1);
      if (html) rows.push(...parseRows(html));
    }
  } else {
    try {
      rows.push(...parseRows(await fetchHtml(`${BASE}/spielplan/`, ctx)));
    } catch (err) {
      console.warn("wiener-volksoper: season spielplan failed:", err);
    }
    for (let back = 0; back <= 2; back++) {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const html = await fetchMonth(ctx, d.getFullYear(), d.getMonth() + 1);
      if (html) rows.push(...parseRows(html));
    }
  }

  return rows;
}

/** Fetch a month page; null for an empty/errored month (pandemic months 500,
 *  pre-archive months render empty) so they aren't logged as hard errors. */
async function fetchMonth(ctx: FetchContext, year: number, month: number): Promise<string | null> {
  const url = `${BASE}/spielplan/${MONTH_SLUGS[month - 1]}-${year}.de.html`;
  try {
    return await fetchHtml(url, ctx);
  } catch (err) {
    if (!/→ 50\d$|→ 404$/.test(String(err))) {
      console.warn(`wiener-volksoper: month ${year}/${month} failed:`, err);
    }
    return null;
  }
}

const ARTICLE_RE = /<article\b[^>]*class="[^"]*event-list-item[^"]*"[\s\S]*?<\/article>/g;

/** Parse the schema.org-microdata `<article>` rows of a spielplan/month page. */
function parseRows(html: string): EventRow[] {
  const rows: EventRow[] = [];
  for (const [article] of matchAllSingle(html, ARTICLE_RE)) {
    const idMatch = article.match(/filter\[production\]=(\d+)/);
    const urlMatch = article.match(/\/produktion\/([a-z0-9.-]+)\.de\.html/i);
    const titleMatch = article.match(/itemprop="name">([^<]*)</);
    const dateMatch = article.match(/<time\b[^>]*datetime="(\d{4}-\d{2}-\d{2})"/);
    const startMatch = article.match(
      /itemprop="startDate"\s*content="(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}))/,
    );
    const descMatch = article.match(/event-description">([^<]*)</);
    const venueMatch = article.match(/event-location">([^<]*)</);

    if (!idMatch?.[1] || !urlMatch?.[1] || !titleMatch?.[1] || !dateMatch?.[1]) continue;

    rows.push({
      productionId: idMatch[1],
      detailUrl: `${BASE}/produktion/${urlMatch[1]}.de.html`,
      title: decodeEntities(titleMatch[1]).trim(),
      description: descMatch?.[1] ? decodeEntities(descMatch[1]).trim() : "",
      date: dateMatch[1] as IsoDate,
      time: startMatch?.[2] ?? null,
      venue: venueMatch?.[1] ? decodeEntities(venueMatch[1]).trim() : VENUE,
    });
  }
  return rows;
}

interface ProductionGroup {
  productionId: string;
  detailUrl: string;
  title: string;
  composer: string;
  performances: RawPerformance[];
}

/**
 * Group flat event rows by their stable production id, applying the opera gate
 * (Oper/Operette genre + a parseable composer), and collect deduped performances
 * honouring `window.since`.
 */
function groupByProduction(rows: EventRow[], window: ScrapeWindow): ProductionGroup[] {
  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map<string, ProductionGroup>();
  const seenPerf = new Set<string>();

  for (const row of rows) {
    if (!isOperaOrOperetta(row.description)) continue;
    const composer = composerFromText(row.description);
    if (!composer) continue;

    if (window.since && row.date < window.since) continue;

    let group = groups.get(row.productionId);
    if (!group) {
      group = {
        productionId: row.productionId,
        detailUrl: row.detailUrl,
        title: row.title,
        composer,
        performances: [],
      };
      groups.set(row.productionId, group);
    }

    const key = `${row.productionId}|${row.date}|${row.time ?? ""}`;
    if (seenPerf.has(key)) continue;
    seenPerf.add(key);

    group.performances.push({
      date: row.date,
      time: row.time,
      venue_room: row.venue,
      status: row.date < today ? "past" : "scheduled",
    });
  }

  return [...groups.values()].filter((g) => g.performances.length > 0);
}

/** The opera gate: keep "Oper"/"Operette" genre lines, drop Musical/Ballett/
 *  Konzert/Kinder. The composer gate (caller) handles non-genre descriptions
 *  ("Ein Stück mit Musik von …", "Liederabend …") that slip past this. */
function isOperaOrOperetta(description: string): boolean {
  const d = description.toLowerCase();
  if (/musical|ballett|konzert|kammermusikalisch|liederabend/.test(d)) return false;
  return /\boperette?\b|\boper\b/.test(d);
}

/** Build a production from its group + the detail page's credit table. */
async function buildProduction(
  group: ProductionGroup,
  ctx: FetchContext,
): Promise<RawProduction | null> {
  let creative_team: RawCredit[] = [];
  let cast: RawCredit[] = [];
  try {
    const html = await fetchHtml(group.detailUrl, ctx);
    ({ creative_team, cast } = parseCredits(html));
  } catch (err) {
    console.warn(`wiener-volksoper: detail ${group.detailUrl} failed:`, err);
  }

  group.performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  return {
    source_production_id: `wiener-volksoper/${group.productionId}`,
    work_title: group.title,
    composer_name: group.composer,
    detail_url: group.detailUrl,
    creative_team,
    cast,
    performances: group.performances,
  };
}

const CREDIT_PAIR_RE =
  /<dt\b[^>]*class="[^"]*\brole\b[^"]*"[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/dd>/g;

/**
 * Cast + creative team from the `<dt class="role">{label}</dt>
 * <dd class="name">{name}</dd>` pairs. A label the German credit map knows is a
 * creative function ("Musikalische Leitung" → conductor); the rest are sung
 * roles. Deduped, since a role line can repeat (e.g. alternating casts).
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, rawLabel, rawName] of matchAllPair(html, CREDIT_PAIR_RE)) {
    const label = stripHtml(rawLabel);
    const name = stripHtml(rawName);
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

function monthEnd(year: number, month: number): IsoDate {
  const last = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}` as IsoDate;
}

/** matchAll wrapper yielding [full] tuples — keeps adapters regex-only, no eval. */
function* matchAllSingle(html: string, re: RegExp): Generator<[string]> {
  for (const m of html.matchAll(re)) yield [m[0]];
}

/** matchAll wrapper yielding [full, g1, g2] tuples for the credit-pair regex. */
function* matchAllPair(html: string, re: RegExp): Generator<[string, string, string]> {
  for (const m of html.matchAll(re)) yield [m[0], m[1] ?? "", m[2] ?? ""];
}
