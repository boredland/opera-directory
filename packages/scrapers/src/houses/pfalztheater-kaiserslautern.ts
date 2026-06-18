import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
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
 * Pfalztheater Kaiserslautern (`spielplan-html`, WordPress, server-rendered).
 *
 * The four-genre Landesbühne has no per-production date list in the DOM (the
 * detail page's `#shows` is JS-filled and empty on fetch). Instead the calendar
 * theme ships a load-more endpoint, `inc/load-more-entries-kalender.php?entries=N`,
 * that server-renders the *whole* announced future as flat `div.single-activity`
 * rows — one per dated night — each carrying title, a "{genre} von {COMPOSER}"
 * `span.writer`, a German "DD. Monat YYYY" date + "HH:MM Uhr" + venue, the detail
 * slug, and a red "Ausverkauft" button when sold out. We pull all rows in one
 * request and regroup by slug into productions.
 *
 * Genre filter: keep `Oper`/`Operette`/`Opern` (the Ravel double-bill is "Opern
 * von …"), drop Rockoper/musical/song-drama. A composer (composerFromText over
 * the writer line) is still required to drop galas/concerts. Per opera we fetch
 * the detail page once for the `div.actors` Besetzung block ("<span>LABEL</span>
 * <a><strong>NAME</strong></a>" rows, alternates split by "<span>|</span>", a
 * "<br><br>" between creative team and sung roles — classified by label).
 *
 * Incremental mode also queries the endpoint with a recent-past datefilter so
 * cast/cancellation corrections that land after a night is played get refreshed.
 * Deep past → Wikidata backfill.
 */

const BASE = "https://pfalztheater.de";
const KAL_ENDPOINT = `${BASE}/wp-content/themes/PT-Theme/inc/load-more-entries-kalender.php`;
/** Pfalztheater Kaiserslautern on Wikidata (the current opera house, not the
 *  demolished Q56284854) — see data/houses.json. */
const WIKIDATA_QID = "Q1344445";

const MONTHS: Record<string, string> = {
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

const RECENT_PAST_DAYS = 45;

interface CalRow {
  slug: string;
  title: string;
  writer: string;
  date: IsoDate;
  time: string | null;
  venue: string | null;
  soldOut: boolean;
}

export async function scrapePfalztheaterKaiserslautern(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const rows = new Map<string, CalRow>();

  try {
    for (const r of parseCalendar(await fetchEntries(ctx, ""))) rows.set(rowKey(r), r);
  } catch (err) {
    console.warn("pfalztheater-kaiserslautern: calendar failed:", err);
  }

  // Recent-past refresh (incremental) / archive walk lower bound (backfill).
  try {
    const since = pastSince(window);
    if (since) {
      const filter = `${toGermanDate(since)} - ${toGermanDate(new Date().toISOString().slice(0, 10))}`;
      for (const r of parseCalendar(await fetchEntries(ctx, filter))) rows.set(rowKey(r), r);
    }
  } catch (err) {
    console.warn("pfalztheater-kaiserslautern: past refresh failed:", err);
  }

  const productions = await buildProductions(ctx, [...rows.values()], window);

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("pfalztheater-kaiserslautern: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "pfalztheater-kaiserslautern", productions };
}

const rowKey = (r: CalRow): string => `${r.slug}|${r.date}|${r.time}`;

async function fetchEntries(ctx: FetchContext, datefilter: string): Promise<string> {
  const url = `${KAL_ENDPOINT}?entries=1000&filter=&datefilter=${encodeURIComponent(datefilter)}&premiere=off`;
  return fetchHtml(url, ctx);
}

/** Each `div.single-activity` is one dated night. */
function parseCalendar(html: string): CalRow[] {
  const rows: CalRow[] = [];
  for (const block of html.split(/<div class="single-activity/).slice(1)) {
    const title = stripHtml(block.match(/class="title">([\s\S]*?)<\/span>/)?.[1] ?? "");
    const writer = stripHtml(block.match(/class="writer">([\s\S]*?)<\/span>/)?.[1] ?? "");
    const slug = block.match(/\/unsere-stuecke\/([^/?"]+)/)?.[1];
    const dm = block.match(/<strong>\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s+(\d{4})\s*<\/strong>/);
    if (!title || !slug || !dm) continue;
    const month = MONTHS[(dm[2] ?? "").toLowerCase()];
    if (!month) continue;
    const date = isoFromParts(dm[3] ?? "", month, dm[1] ?? "");
    if (!date) continue;

    const details =
      block.match(/class="details-column">([\s\S]*?)class="button-column"/)?.[1] ?? block;
    const time = details.match(/(\d{1,2}:\d{2})\s*(?:&nbsp;)?\s*Uhr/)?.[1] ?? null;
    const venue =
      stripHtml(details.match(/Uhr(?:&nbsp;|\s)*<\/?br\s*\/?>([\s\S]*?)<\/div>/)?.[1] ?? "") ||
      null;
    rows.push({ slug, title, writer, date, time, venue, soldOut: /Ausverkauft/i.test(block) });
  }
  return rows;
}

/** Keep opera/operetta only; a Rockoper/musical never survives the genre gate. */
function isOpera(writer: string): boolean {
  if (/rock|pop|musical|song|tanz|schauspiel|kom(ö|oe)die/i.test(writer)) return false;
  return /\boper(ette)?n?\b/i.test(writer);
}

async function buildProductions(
  ctx: FetchContext,
  rows: CalRow[],
  window: ScrapeWindow,
): Promise<RawProduction[]> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, CalRow[]>();
  for (const r of rows) {
    if (!isOpera(r.writer)) continue;
    (bySlug.get(r.slug) ?? bySlug.set(r.slug, []).get(r.slug))?.push(r);
  }

  const productions: RawProduction[] = [];
  for (const [slug, group] of bySlug) {
    const composer = composerFromText(group[0]?.writer ?? "");
    if (!composer) continue;

    const performances: RawPerformance[] = [];
    const seen = new Set<string>();
    for (const r of group) {
      if (window.since && r.date < window.since) continue;
      const key = `${r.date}|${r.time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      performances.push({
        date: r.date,
        time: r.time,
        venue_room: r.venue,
        status: r.date < today ? "past" : r.soldOut ? "sold_out" : "scheduled",
      });
    }
    if (performances.length === 0) continue;
    performances.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );

    const { cast, creative } = await fetchCast(ctx, slug);
    productions.push({
      source_production_id: slug,
      work_title: group[0]?.title ?? slug,
      composer_name: composer,
      detail_url: `${BASE}/unsere-stuecke/${slug}/`,
      creative_team: creative,
      cast,
      performances,
    });
  }
  return productions;
}

/** `div.actors` Besetzung: "<span>LABEL</span> <a><strong>NAME</strong></a>" rows,
 *  alternate casts split by "<span>|</span>". A mapped label is a creative
 *  function, anything else a sung role. Skips ensemble pseudo-roles (Orchester/Chor). */
async function fetchCast(
  ctx: FetchContext,
  slug: string,
): Promise<{ cast: RawCredit[]; creative: RawCredit[] }> {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  let seg = "";
  try {
    const html = await fetchHtml(`${BASE}/unsere-stuecke/${slug}/`, ctx);
    seg = html.match(/class="[^"]*actors[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? "";
  } catch (err) {
    console.warn(`pfalztheater-kaiserslautern: cast ${slug} failed:`, err);
    return { cast, creative };
  }

  for (const line of seg.split(/<br\s*\/?>/)) {
    const label = stripHtml(line.match(/<span>([\s\S]*?)<\/span>/)?.[1] ?? "");
    if (!label || label === "|") continue;
    if (/^(orchester|chor|extrachor|statisterie)$/i.test(label)) continue;
    const names = [...line.matchAll(/<strong>([\s\S]*?)<\/strong>/g)]
      .map((m) => stripHtml(m[1] ?? ""))
      .filter(Boolean);
    for (const name of names) {
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}

/** Lower bound for the recent-past calendar query, or null when none is needed. */
function pastSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since; // null → endpoint floors at its own oldest
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - RECENT_PAST_DAYS);
  return d.toISOString().slice(0, 10) as IsoDate;
}

function toGermanDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
