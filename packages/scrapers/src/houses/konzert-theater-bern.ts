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
 * Bühnen Bern — formerly Konzert Theater Bern (`spielplan-html` strategy).
 *
 * A four-genre house (Bern, Switzerland) staging opera, Schauspiel, Tanz and
 * concerts side by side. The site is German-language SSR HTML on a ProcessWire
 * CMS — no JSON-LD, no public API — but it server-renders everything we need, so
 * this reads the rendered markup directly (no headless render).
 *
 * Discovery — the season programme is one month at a time: the calendar
 * `/spielplan/programm/` carries a `<select name="month">` whose options span the
 * whole announced season ("6-2026" … "7-2027"). Each `?month=M-YYYY` page lists
 * its `/spielplan/programm/{slug}/` detail links, which are deduped into the
 * production set. The future leg ignores `window.since`; backfill adds the
 * Wikidata leg (the site publishes no scrapable past archive).
 *
 * OPERA GATE — the house tags every performance with a `division` ("Oper",
 * "Schauspiel", "Tanz", "Berner Symphonieorchester", "Sonderveranstaltungen"…).
 * A production is opera iff its detail page carries division "Oper" AND a
 * composer can be read from its genre line. That drops Schauspiel, Tanz, concerts
 * and Sonderveranstaltungen; it keeps the works the house itself files as opera
 * (incl. operetta/musical, e.g. My Fair Lady).
 *
 * Per detail page:
 *   - composer: the `acc-item-sub-title` block prints the genre line ("Oper in
 *     vier Akten von Giuseppe Verdi", "Melodramma von Pietro Mascagni", "… Musik
 *     von Frederick Loewe"); composerFromText pulls the name and is the
 *     REQUIRE-a-composer gate. (A two-work bill like Cavalleria/Pagliacci yields
 *     the first composer — the schema's one-work-per-production limit, README §5.)
 *   - title: `<h1>` / `og:title`.
 *   - performances: `cp-calendar-item` blocks (date `DD.MM.YYYY`, time `HH:MM`,
 *     `location` room, sold-out / few-left / last-time status flags).
 *   - creative team: `el-prod-team-item` (`<h3 class="function">` + `<a
 *     class="name">`), mapped via normalizeGermanCredit.
 *   - cast: `el-ensemble-item` (`<h3 class="name">` then `<p class="function">`
 *     holding the sung role), kept verbatim.
 */

const BASE = "https://www.buehnenbern.ch";
const PROGRAMM = `${BASE}/spielplan/programm/`;

/**
 * Konzert Theater Bern on Wikidata — Q54911483 ("Konzert Theater Bern", the arts
 * organization, P31 = Q105815710). Verified via wbsearchentities (label match)
 * AND by SPARQL: it is the only Bern entity carrying a P272 production item,
 * whereas the separate building record Q869926 ("Stadttheater Bern" / alias
 * "Bühnen Bern") carries none. Backfill coverage is effectively nil (its one
 * production item is an unlabeled bare-QID the wikidata strategy skips), but the
 * QID is the authoritative resolution anchor.
 */
const WIKIDATA_QID = "Q54911483";

/** The house's own genre tag for opera (incl. operetta/musical it files there). */
const OPERA_DIVISION = "Oper";

export async function scrapeKonzertTheaterBern(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const url of await collectDetailUrls(ctx)) {
      try {
        const prod = await buildProduction(ctx, url, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`konzert-theater-bern: detail ${url} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("konzert-theater-bern: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("konzert-theater-bern: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "konzert-theater-bern", productions };
}

/**
 * Collect unique production detail URLs across the announced season. The
 * programme paginates by month via `?month=M-YYYY`; the options are read from the
 * calendar's `<select name="month">` so the walk tracks the published season.
 */
async function collectDetailUrls(ctx: FetchContext): Promise<string[]> {
  const first = await fetchHtml(PROGRAMM, ctx);
  const urls = new Set<string>();
  addDetailUrls(first, urls);

  for (const month of parseMonths(first)) {
    try {
      addDetailUrls(await fetchHtml(`${PROGRAMM}?month=${month}`, ctx), urls);
    } catch (err) {
      console.warn(`konzert-theater-bern: month ${month} failed:`, err);
    }
  }

  return [...urls];
}

/** `<option value="6-2026">…` inside the month `<select>` — the season's span. */
function parseMonths(html: string): string[] {
  const months = new Set<string>();
  for (const [, value] of html.matchAll(/<option value="(\d{1,2}-\d{4})"/g)) {
    if (value) months.add(value);
  }
  return [...months];
}

function addDetailUrls(html: string, urls: Set<string>): void {
  for (const [, slug] of html.matchAll(/\/spielplan\/programm\/([a-z0-9-]+)\//g)) {
    if (slug) urls.add(`${BASE}/spielplan/programm/${slug}/`);
  }
}

async function buildProduction(
  ctx: FetchContext,
  url: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(url, ctx);

  // OPERA GATE — the production must be tagged opera by the house and expose a
  // composer; either failing drops Schauspiel / Tanz / Konzert.
  if (!isOpera(html)) return null;
  const composer = parseComposer(html);
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html);
  if (!title) return null;

  const slug = url.match(/programm\/([a-z0-9-]+)\//)?.[1] ?? url;
  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `konzert-theater-bern/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    image_url: parseImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** True iff any of the page's performance `division` tags is the opera genre. */
function isOpera(html: string): boolean {
  for (const [, division] of html.matchAll(/class="division">\s*([^<]+?)\s*<\/div>/g)) {
    if (division?.trim() === OPERA_DIVISION) return true;
  }
  return false;
}

/** Composer from the `acc-item-sub-title` genre line ("Oper … von {Name}",
 *  "Melodramma von {Name}", "… Musik von {Name}"). The first sub-title block is
 *  the venue; each `<br>`-separated line of every block is tried until
 *  composerFromText returns a name. Splitting on `<br>` keeps the composer line
 *  ("von Giacomo Puccini") from running into a following "Dichtung von …" /
 *  "Deutsch von …" credit. */
function parseComposer(html: string): string | null {
  const lines: string[] = [];
  for (const [, block] of html.matchAll(/acc-item-sub-title">\s*([\s\S]*?)<\/div>/g)) {
    if (!block) continue;
    for (const part of block.split(/<br\s*\/?>/i)) lines.push(stripHtml(part));
  }

  // Prefer an explicit "Musik von …" line — works whose composer isn't the
  // primary author (e.g. My Fair Lady) print "Buch von X / Musik von {composer}".
  for (const line of lines) {
    if (/Musik von|\(Musik\)/i.test(line)) {
      const composer = composerFromText(line);
      if (composer) return composer;
    }
  }
  for (const line of lines) {
    const composer = composerFromText(line);
    if (composer) return composer;
  }
  return null;
}

function parseTitle(html: string): string | null {
  const og = html.match(/property="og:title"\s+content="([^"]*)"/i)?.[1];
  if (og) return decodeEntities(og).trim() || null;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return h1 ? stripHtml(h1) || null : null;
}

function parseImage(html: string): string | null {
  return html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1]?.trim() || null;
}

/**
 * Performance rows from the `cp-calendar-item` blocks: date `DD.MM.YYYY`, time
 * `HH:MM`, the `location` room, and a status from the item's flags (Ausverkauft →
 * sold_out, "few tickets" → few_left, else scheduled / past by date).
 */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const itemRe = /cp-calendar-item([\s\S]*?)(?=cp-calendar-item|el-prod-team|el-ensemble|$)/g;
  for (const [, item] of html.matchAll(itemRe)) {
    if (!item) continue;
    const date = parseDate(item.match(/class="h3 date">\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/));
    if (!date) continue;
    if (window.since && date < window.since) continue;

    const time = item.match(/class="h3 time">\s*(\d{1,2}:\d{2})/)?.[1] ?? null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const roomRaw = item.match(
      /class="[^"]*location"[^>]*>\s*(?:<a[^>]*>)?\s*([\s\S]*?)\s*(?:<\/a>|<\/div>)/,
    );
    out.push({
      date,
      time,
      venue_room: roomRaw?.[1] ? stripHtml(roomRaw[1]) || null : null,
      status: parseStatus(item, date, today),
    });
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

function parseDate(m: RegExpMatchArray | null): IsoDate | null {
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` as IsoDate;
}

function parseStatus(item: string, date: IsoDate, today: string): RawPerformance["status"] {
  if (/Ausverkauft/i.test(item)) return "sold_out";
  if (/nearly-sold-out|Nur noch wenige/i.test(item)) return "few_left";
  return date < today ? "past" : "scheduled";
}

/**
 * Cast + creative team. The creative team lives in `el-prod-team-item` blocks
 * (a German function label then a linked name); a label the German credit map
 * knows is a creative function. The cast lives in `el-ensemble-item` blocks
 * pairing a name (`name` h3) with a sung role (`function` p), kept verbatim.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  const teamRe =
    /<h3\s+class="function">\s*([\s\S]*?)\s*<\/h3>\s*<a[^>]*class="[^"]*\bname\b[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/a>/g;
  for (const [, rawLabel, rawName] of html.matchAll(teamRe)) {
    const label = rawLabel ? stripHtml(rawLabel) : "";
    const name = rawName ? stripHtml(rawName) : "";
    if (!label || !name) continue;
    const credit = normalizeGermanCredit(label, name);
    const key = `${credit.function ?? credit.role}|${name}`;
    if (seenCreative.has(key)) continue;
    seenCreative.add(key);
    creative_team.push(credit);
  }

  const castRe =
    /<h3\s+class="name">\s*([\s\S]*?)\s*<\/h3>\s*<p\s+class="function">\s*([\s\S]*?)\s*<\/p>/g;
  for (const [, rawName, rawRole] of html.matchAll(castRe)) {
    const name = rawName ? stripHtml(rawName) : "";
    const role = rawRole ? stripHtml(rawRole) : "";
    if (!name) continue;
    const key = `${role}|${name}`;
    if (seenCast.has(key)) continue;
    seenCast.add(key);
    cast.push(role ? { role, name } : { name });
  }

  return { creative_team, cast };
}
