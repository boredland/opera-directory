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
 * Theater Lüneburg (`json-api`, Neos CMS, server-rendered, no proxy).
 *
 * The musiktheater sparte page (`/spielplan/musiktheater`) is a shell: its
 * schedule is injected from an AJAX endpoint referenced by a `data-replace`
 * attribute pointing at `/api/performances?…&documentNode[__contextNodePath]=…
 * &productionType=…&tag=…`. We read that attribute (the contextNodePath +
 * productionType GUID are environment-specific, so we never hardcode them),
 * drop the `tag` filter to get the whole season, and fetch the endpoint — which
 * returns one flat `<article class="Performance">` per dated showing carrying
 * the production title, a "{genre} von {Composer}" subtitle, the venue+date line
 * ("{Room} - {Wd} {D}. {Monat} um HH:MM Uhr"), a Premiere/reopening tag, and a
 * `ProductionLink` href (the detail slug). Rows are grouped by slug into one
 * production; year+month come from the row's `data-selector-value`
 * ("2025-October"), the day from the German venue line.
 *
 * The sparte page mixes opera/operetta with musicals, so we gate on the genre
 * word in the subtitle (Oper/Operette/Opera/Musikdrama/Singspiel, never Musical)
 * AND require a composer (composerFromText) — dropping musicals, monologues and
 * concerts. Cast + creative team come from the production detail page, whose
 * `<div class="Cast"><div class="Cast-label">LABEL</div><div class="Cast-person">
 * NAME</div></div>` rows share one shape for both: a label that maps via
 * normalizeGermanCredit → creative_team, otherwise LABEL is a sung role → cast.
 * Future-only repertoire → Wikidata backfill.
 */

const BASE = "https://www.theater-lueneburg.de";
/** Theater Lüneburg on Wikidata — verified "theatre and opera house in Lüneburg". */
const WIKIDATA_QID = "Q2415852";

const GERMAN_MONTHS: Record<string, string> = {
  Januar: "01",
  Februar: "02",
  März: "03",
  April: "04",
  Mai: "05",
  Juni: "06",
  Juli: "07",
  August: "08",
  September: "09",
  Oktober: "10",
  November: "11",
  Dezember: "12",
};

/** Opera/operetta gate — the genre word in the subtitle (matches compounds like
 *  "Kinderoper", so no leading word boundary), but never a musical. */
const OPERA_GENRE = /oper|opera|musikdrama|singspiel/i;

export async function scrapeTheaterLueneburg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const listing = await fetchHtml(`${BASE}/spielplan/musiktheater`, ctx);
    const apiUrl = scheduleApiUrl(listing);
    if (apiUrl) {
      const schedule = await fetchHtml(apiUrl, ctx);
      for (const prod of await buildProductions(ctx, schedule, window)) {
        productions.push(prod);
      }
    } else {
      console.warn("theater-lueneburg: no /api/performances data-replace on listing");
    }
  } catch (err) {
    console.warn("theater-lueneburg: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-lueneburg: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-lueneburg", productions };
}

/** Read the schedule AJAX URL from the listing's `data-replace`, dropping the
 *  `tag` filter so the endpoint returns the whole season (not just premieres). */
function scheduleApiUrl(html: string): string | null {
  const raw = html.match(/data-replace="(\/api\/performances[^"]*)"/)?.[1];
  if (!raw) return null;
  const path = decodeEntities(raw).replace(/&tag=[^&]*/g, "");
  return `${BASE}${path}`;
}

interface ScheduleRow {
  slug: string;
  title: string;
  subtitle: string;
  date: IsoDate;
  time: string | null;
  venue: string | null;
  isPremiere: boolean;
}

async function buildProductions(
  ctx: FetchContext,
  scheduleHtml: string,
  window: ScrapeWindow,
): Promise<RawProduction[]> {
  const byslug = new Map<string, ScheduleRow[]>();
  for (const row of parseScheduleRows(scheduleHtml)) {
    const rows = byslug.get(row.slug) ?? [];
    rows.push(row);
    byslug.set(row.slug, rows);
  }

  const today = new Date().toISOString().slice(0, 10);
  const productions: RawProduction[] = [];
  for (const [slug, rows] of byslug) {
    const first = rows[0];
    if (!first) continue;
    if (OPERA_GENRE.test(first.subtitle) === false || /\bmusical\b/i.test(first.subtitle)) continue;
    // The genre+composer is the first "|"-separated segment; later segments are
    // librettist/translation credits that would otherwise bleed into the name.
    const composer = composerFromText(first.subtitle.split("|")[0] ?? first.subtitle);
    if (!composer) continue;

    const seen = new Set<string>();
    const performances: RawPerformance[] = [];
    for (const row of rows) {
      const key = `${row.date}|${row.time}`;
      if ((window.since && row.date < window.since) || seen.has(key)) continue;
      seen.add(key);
      performances.push({
        date: row.date,
        time: row.time,
        venue_room: row.venue,
        status: row.date < today ? "past" : "scheduled",
      });
    }
    if (performances.length === 0) continue;
    performances.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );

    const detailUrl = `${BASE}${slug}`;
    let cast: RawCredit[] = [];
    let creative: RawCredit[] = [];
    try {
      ({ cast, creative } = parseCast(await fetchHtml(detailUrl, ctx)));
    } catch (err) {
      console.warn(`theater-lueneburg: ${slug} detail failed:`, err);
    }

    productions.push({
      source_production_id: slug.replace(/^\//, ""),
      work_title: first.title,
      composer_name: composer,
      premiere_date: rows.find((r) => r.isPremiere)?.date ?? null,
      detail_url: detailUrl,
      creative_team: creative,
      cast,
      performances,
    });
  }
  return productions;
}

const ENGLISH_MONTHS: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

/** One `<article class="…Performance…">` per dated showing. The day + (German)
 *  month come from the venue line — the authoritative date; `data-selector-value`
 *  ("2025-October") only carries the year, and its month is a schedule bucket that
 *  occasionally lags the real date (a Dec bucket holding a Jan showing), so we
 *  bump the year when the venue month wraps back past the bucket month. */
function parseScheduleRows(html: string): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  for (const m of html.matchAll(
    /<article class="Schedule-row Performance[^"]*"[^>]*data-selector-value="(\d{4})-(\w+)">([\s\S]*?)<\/article>/g,
  )) {
    const bucketYear = Number.parseInt(m[1] ?? "", 10);
    const bucketMonth = ENGLISH_MONTHS[m[2] ?? ""] ?? 0;
    const body = m[3] ?? "";
    const title = stripHtml(body.match(/Performance-productionTitle">([\s\S]*?)<\/h3>/)?.[1] ?? "");
    const subtitle = stripHtml(
      body.match(/Performance-productionSubtitle">([\s\S]*?)<\/div>/)?.[1] ?? "",
    );
    const slug = body.match(/ProductionLink"\s+href="([^"]+)"/)?.[1];
    const venueLine = stripHtml(body.match(/Performance-venue">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const tag = stripHtml(body.match(/Performance-tag[^"]*">([\s\S]*?)<\/span>/)?.[1] ?? "");
    if (!title || !slug || !venueLine) continue;

    const vm = venueLine.match(/^(.*?)\s*-\s*\w{2}\s+(\d{1,2})\.\s+(\S+)\s+um\s+(\d{2}):(\d{2})/);
    if (!vm) continue;
    const month = GERMAN_MONTHS[vm[3] ?? ""];
    if (!month || !bucketYear || !bucketMonth) continue;
    const monthNum = Number.parseInt(month, 10);
    const year = bucketYear + (monthNum < bucketMonth && bucketMonth - monthNum > 6 ? 1 : 0);
    const date = `${year}-${month}-${(vm[2] ?? "").padStart(2, "0")}` as IsoDate;
    // 00:00 is the house's placeholder for an unannounced time.
    const time = vm[4] === "00" && vm[5] === "00" ? null : `${vm[4]}:${vm[5]}`;

    rows.push({
      slug,
      title,
      subtitle,
      date,
      time,
      venue: (vm[1] ?? "").trim() || null,
      isPremiere: /premiere/i.test(tag),
    });
  }
  return rows;
}

/** `Cast` rows on the detail page: `<div class="Cast-label">LABEL</div>
 *  <div class="Cast-person"><a|span>NAME</a></div>`. A label that maps to a
 *  creative function → creative_team; otherwise LABEL is a sung role → cast.
 *  Names carry an "a. G." (als Gast) marker we strip — it's not part of a name. */
function parseCast(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  for (const m of html.matchAll(
    /<div class="Cast"><div class="Cast-label">([\s\S]*?)<\/div><div class="Cast-person">([\s\S]*?)<\/div><\/div>/g,
  )) {
    // "Inzenierung" is the house's consistent misspelling of "Inszenierung"
    // (director) on every detail page — correct it so it maps, not lands in cast.
    const label = stripHtml(m[1] ?? "").replace(/^Inzenierung$/i, "Inszenierung");
    if (!label) continue;
    for (const name of personNames(m[2] ?? "")) {
      if (/^N\.?\s*N\.?$/.test(name)) continue;
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}

/** A `Cast-person` cell holds one or more names as `<a>`/`<span>` elements
 *  (comma-joined for shared roles); fall back to comma-split plain text. The
 *  "a. G." (als Gast) guest marker is trimmed — it's not part of the name. */
function personNames(cell: string): string[] {
  const tagged = [...cell.matchAll(/<(?:a[^>]*|span)>([^<]+)<\/(?:a|span)>/g)].map((m) =>
    stripHtml(m[1] ?? ""),
  );
  const raw = tagged.length > 0 ? tagged : stripHtml(cell).split(",");
  return raw.map((n) => n.replace(/\s+a\.\s*G\.\s*$/, "").trim()).filter((n) => n.length > 0);
}
