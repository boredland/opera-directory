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

/**
 * Macerata Opera Festival (`spielplan-html` strategy, WordPress + WPBakery).
 *
 * FESTIVAL — a summer-only open-air festival at the Arena Sferisterio in Macerata,
 * staging a single edition each July–August and empty of programme the rest of
 * the year. The live leg is the CURRENT edition only: each edition has an index
 * at `/macerata-opera-festival-{YEAR}` linking the programme items as
 * `/macerata-opera-festival/{slug}-{YEAR}`. The deep history of past editions
 * isn't a walkable archive, so backfill comes from Wikidata.
 *
 * The Italian pages (no `/en/` prefix) are scraped, not the English mirror: the
 * Italian side keeps the composer subtitle the English template drops (Nabucco's
 * `subtitle-mof` is empty in English) and prints the credit labels we map below.
 * Each detail page carries the work title in the first `vc_custom_heading`, the
 * composer in `<div class="subtitle-mof">` (sometimes prefixed "di "), the dates
 * as `dayweek/nroday/meseabbr/clocktime` spans (no year — derived from the
 * edition), and a `<ul class="cast-opera">` whose `ruolocast/artistacast` rows
 * are first the creative team (Italian labels) then the sung cast.
 *
 * The festival also stages a scenic cantata (Carmina Burana, billed by voice type
 * — Soprano/Tenore/Baritono, no character roles) alongside the operas. As with
 * arena-di-verona, opera is decided structurally: REQUIRE a composer AND a sung
 * cast of named character roles, which drops the cantata, concerts and galas.
 */

const BASE = "https://www.sferisterio.it";
/** Macerata Opera (P31 = opera festival + music organization, P17 = Italy,
 *  P276 = Q1060110 the Sferisterio arena it performs in) — the FESTIVAL body,
 *  verified via wbsearchentities (alias "Macerata Opera Festival"). NOT the arena
 *  building Q1060110 ("Sferisterio di Macerata"). */
const WIKIDATA_QID = "Q6723253";
const VENUE = "Arena Sferisterio";

/** Italian creative-function labels → canonical function keys, tested in order.
 *  Any label containing "regia" is a director credit first (the site combines it,
 *  e.g. "Ripresa della regia"), so it precedes the set/costume rules. "Ripresa da"
 *  (revival staging) and "Scene e costumi" (a shared set+costume credit) appear on
 *  this house's pages too. */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/direzione d['’]orchestra|^direttore|^maestro concertatore/i, "conductor"],
  [/maestro del coro|direttore del coro/i, "chorus-master"],
  [/regia/i, "director"],
  [/ripresa da/i, "director"],
  [/coreografi/i, "choreographer"],
  [/drammaturgia/i, "dramaturgy"],
  [/disegno luci|^luci\b/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi/i, "costume-designer"],
  [/scenografia|^scene\b/i, "set-designer"],
  [/^video|videodesign|disegno video/i, "video-designer"],
];

/** Voice-type "roles" mark a concert or cantata billing (Carmina Burana →
 *  Soprano/Tenore/Baritono), not a staged character. */
const NON_CHARACTER_ROLES = new Set([
  "soprano",
  "mezzosoprano",
  "mezzo-soprano",
  "contralto",
  "tenore",
  "tenor",
  "baritono",
  "baritone",
  "basso",
  "bass",
  "controtenore",
  "countertenore",
  "voce recitante",
  "narratore",
]);

const MONTHS: Record<string, string> = {
  gennaio: "01",
  febbraio: "02",
  marzo: "03",
  aprile: "04",
  maggio: "05",
  giugno: "06",
  luglio: "07",
  agosto: "08",
  settembre: "09",
  ottobre: "10",
  novembre: "11",
  dicembre: "12",
};

export async function scrapeMacerataOperaFestival(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const edition = await findCurrentEdition(ctx);
    if (edition) {
      for (const url of edition.detailUrls) {
        try {
          const prod = await buildProduction(ctx, url, edition.year, window);
          if (prod) productions.push(prod);
        } catch (err) {
          console.warn(`macerata-opera-festival: ${url} failed:`, err);
        }
      }
    } else {
      console.warn("macerata-opera-festival: no current edition index found");
    }
  } catch (err) {
    console.warn("macerata-opera-festival: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("macerata-opera-festival: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "macerata-opera-festival", productions };
}

/** The current edition (July–August festival → current calendar year, with the
 *  next year as a fallback once an edition publishes early). Returns the first
 *  `/macerata-opera-festival-{YEAR}` index that exists, with the detail URLs of
 *  its programme items (those ending in the edition year, deduped). */
async function findCurrentEdition(
  ctx: FetchContext,
): Promise<{ year: number; detailUrls: string[] } | null> {
  const thisYear = new Date().getUTCFullYear();
  for (const year of [thisYear, thisYear + 1, thisYear - 1]) {
    try {
      const html = await fetchHtml(`${BASE}/macerata-opera-festival-${year}`, ctx);
      const urls = parseIndex(html, year);
      if (urls.length > 0) return { year, detailUrls: urls };
    } catch {
      // try next candidate year
    }
  }
  return null;
}

function parseIndex(html: string, year: number): string[] {
  const urls = new Set<string>();
  const re = new RegExp(
    `href="(${BASE.replace(/[.]/g, "\\.")}/macerata-opera-festival/[a-z0-9-]+-${year})"`,
    "gi",
  );
  for (const [, url] of html.matchAll(re)) if (url) urls.add(url);
  return [...urls];
}

async function buildProduction(
  ctx: FetchContext,
  url: string,
  year: number,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(url, ctx);

  const title = stripHtml(
    html.match(/<h2[^>]*\bvc_custom_heading\b[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "",
  );
  if (!title) return null;

  const composer = parseComposer(html);
  if (!composer) return null;

  const { creative_team, cast } = parseCast(html);
  // No named character role ⇒ a cantata, concert or gala sharing the programme.
  if (cast.length === 0) return null;

  const performances = parseDates(html, year, window);
  if (performances.length === 0) return null;

  return {
    source_production_id: url.replace(/\/$/, "").split("/").pop() ?? url,
    work_title: title,
    composer_name: composer,
    premiere_season: String(year),
    detail_url: url,
    image_url:
      html.match(/class="vc_single_image-wrapper[^"]*">\s*<img[^>]+src="([^"]+)"/)?.[1] ?? null,
    creative_team,
    cast,
    performances,
  };
}

/** `<div class="myrow myaligncenter subtitle-mof">Giuseppe Verdi</div>` or "di
 *  Gioachino Rossini" — the composer printed under the title (the "di {name}"
 *  inside the genre prose is the librettist, so we read only this dedicated
 *  subtitle). The `myaligncenter` class disambiguates it from a bare
 *  `subtitle-mof` social-links label elsewhere on the page. */
function parseComposer(html: string): string | null {
  const raw = html.match(
    /class="[^"]*\bmyaligncenter\b[^"]*\bsubtitle-mof\b[^"]*"[^>]*>([\s\S]*?)<\/div>/,
  )?.[1];
  if (!raw) return null;
  const name = decodeEntities(stripHtml(raw))
    .replace(/^di\s+/i, "")
    .trim();
  return name.length >= 3 ? name : null;
}

/**
 * `<ul class="cast-opera">` holds both teams as `<li>` rows of
 * `<div class="ruolocast">Label</div><div class="artistacast">Name</div>`. A
 * mapped Italian function label is a creative credit; anything else is a sung role
 * unless its label is a bare voice type (concert/cantata billing — dropped). Empty
 * rows act as the visual separator between the creative team and the cast.
 */
function parseCast(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  const ul = html.match(/<ul class="cast-opera">([\s\S]*?)<\/ul>/)?.[1] ?? "";
  for (const [, row] of ul.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const label = decodeEntities(
      stripHtml(row?.match(/ruolocast"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ""),
    )
      .replace(/[:.]\s*$/, "")
      .trim();
    const name = decodeEntities(
      stripHtml(row?.match(/artistacast"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ""),
    ).trim();
    if (!label || !name) continue;

    const fn = mapFunction(label);
    if (fn) {
      pushUnique(creative_team, seen, `${fn}|${name}`, { function: fn, name });
    } else if (!NON_CHARACTER_ROLES.has(label.toLowerCase())) {
      pushUnique(cast, seen, `role|${label}|${name}`, { role: label, name });
    }
  }

  return { creative_team, cast };
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

function pushUnique(out: RawCredit[], seen: Set<string>, key: string, credit: RawCredit): void {
  if (seen.has(key)) return;
  seen.add(key);
  out.push(credit);
}

/**
 * Each date is a `<div class="time-opera">` with `nroday`/`meseabbr`/`clocktime`
 * spans, e.g. "17 Luglio H 21:00". The markup carries no year, so it's taken from
 * the edition; the day-of-week span is decorative and ignored.
 */
function parseDates(html: string, year: number, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, block] of html.matchAll(/<div class="time-opera">([\s\S]*?)<\/div>/g)) {
    if (!block) continue;
    const day = block.match(/nroday">([^<]*)</)?.[1]?.trim();
    const monthName = stripHtml(block.match(/meseabbr">([\s\S]*?)</)?.[1] ?? "").toLowerCase();
    const month = MONTHS[monthName];
    if (!day || !month) continue;

    const timeRaw = block.match(/clocktime">[^0-9]*(\d{1,2})[.:](\d{2})/);
    const time = timeRaw ? `${timeRaw[1]?.padStart(2, "0")}:${timeRaw[2]}` : null;

    const date = `${year}-${month}-${day.padStart(2, "0")}` as IsoDate;
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (window.since && date < window.since) continue;
    out.push({ date, time, venue_room: VENUE, status: date < today ? "past" : "scheduled" });
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}
