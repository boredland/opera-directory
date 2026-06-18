import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, proxyFetch, stripHtml } from "../fetch";
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
 * Stadttheater Gießen (ProcessWire CMS, `json-api`; server-rendered details).
 *
 * The spielplan is fed by an AJAX endpoint that returns one month of items per
 * call: `/de/ajax/?action=load_items&selectedCategory[]=1040&selectedMonth={M}
 * &selectedYear={YYYY}` (category 1040 = Musiktheater). The endpoint only emits
 * JSON when the request carries `X-Requested-With: XMLHttpRequest` — without it
 * ProcessWire renders the full HTML page — so it can't go through `fetchJson`
 * (which sets Accept only); we hand-build the request via `proxyFetch`.
 *
 * The Musiktheater category mixes in musicals (e.g. "The Addams Family",
 * "Cabaret"), so each item is kept only when a composer can be read from the
 * `excerpt` ("Oper … von {Composer} | Libretto …") and it isn't a musical.
 * Items are grouped by detail `url`; the detail page's "Besetzung" accordion
 * gives the creative team (and any sung cast), as German label text nodes each
 * followed by `<a href="/de/personen/…">NAME</a>` links. Future/season-only →
 * Wikidata backfill.
 */

const BASE = "https://stadttheater-giessen.de";
const MUSIKTHEATER_CATEGORY = 1040;
const MONTHS_AHEAD = 14;
/** Stadttheater Gießen on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2328206";

interface ListItem {
  date?: string;
  startTime?: string;
  title?: string;
  excerpt?: string;
  category?: string;
  location?: string;
  url?: string;
  premiere?: boolean;
  cancelled?: boolean;
}

interface ListResponse {
  success?: boolean;
  data?: ListItem[];
}

export async function scrapeStadttheaterGiessen(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const byUrl = await walkSchedule(ctx, window);
    for (const [url, item] of byUrl) {
      try {
        const prod = await buildProduction(ctx, url, item);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`stadttheater-giessen: ${url} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("stadttheater-giessen: schedule failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("stadttheater-giessen: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "stadttheater-giessen", productions };
}

interface Grouped {
  item: ListItem;
  performances: RawPerformance[];
}

/** Walk the month AJAX endpoint forward from the current month, keeping opera
 *  items and grouping their performances by detail url. */
async function walkSchedule(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<Map<string, Grouped>> {
  const today = new Date().toISOString().slice(0, 10);
  const startMonth = today.slice(0, 7);
  const byUrl = new Map<string, Grouped>();

  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    const [year, month] = addMonths(startMonth, i).split("-").map(Number) as [number, number];
    const items = await fetchMonth(ctx, month, year);
    for (const item of items) {
      const url = item.url;
      if (!url || !isOpera(item)) continue;
      const date = isoDate(item.date, year);
      if (!date) continue;
      if (window.since && date < window.since) continue;
      const time = item.startTime?.trim() || null;
      const status = item.cancelled ? "cancelled" : date < today ? "past" : "scheduled";
      const group = byUrl.get(url) ?? { item, performances: [] };
      if (!group.performances.some((p) => p.date === date && p.time === time)) {
        group.performances.push({
          date,
          time,
          venue_room: cleanText(item.location) || null,
          status,
        });
      }
      byUrl.set(url, group);
    }
  }
  return byUrl;
}

/** One month of Musiktheater items. The endpoint returns the full HTML page
 *  unless the request is marked as an XHR, so set the header explicitly. */
async function fetchMonth(ctx: FetchContext, month: number, year: number): Promise<ListItem[]> {
  const url = `${BASE}/de/ajax/?action=load_items&selectedCategory[]=${MUSIKTHEATER_CATEGORY}&selectedMonth=${month}&selectedYear=${year}`;
  const res = await proxyFetch(url, ctx.proxy, {
    headers: {
      "User-Agent": ctx.userAgent,
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} → ${res.status}`);
  // The XHR response body is JSON but mislabeled "text/html" — parse the text
  // directly (a non-XHR request returns a real HTML page, caught by JSON.parse).
  const text = await res.text();
  let body: ListResponse;
  try {
    body = JSON.parse(text) as ListResponse;
  } catch {
    throw new Error(`expected JSON for ${url} (got HTML — XHR header missing?)`);
  }
  if (!body.success) throw new Error(`load_items not successful for ${url}`);
  return body.data ?? [];
}

/** Keep opera/operetta — category tagged Musiktheater, a composer readable from
 *  the excerpt, and not a musical. */
function isOpera(item: ListItem): boolean {
  if (!/Musiktheater/i.test(item.category ?? "")) return false;
  const excerpt = cleanText(item.excerpt);
  const title = cleanText(item.title);
  if (/musical/i.test(excerpt) || /musical/i.test(title)) return false;
  return composerFrom(item) !== null;
}

/** Composer from the excerpt's first "|"-segment ("Oper in drei Akten von …"),
 *  before the libretto/language clauses that follow each bar. */
function composerFrom(item: ListItem): string | null {
  const firstSegment = cleanText(item.excerpt).split("|")[0] ?? "";
  return composerFromText(firstSegment);
}

async function buildProduction(
  ctx: FetchContext,
  url: string,
  group: Grouped,
): Promise<RawProduction | null> {
  const { item, performances } = group;
  if (performances.length === 0) return null;
  const composer = composerFrom(item);
  if (!composer) return null;

  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  const detailUrl = `${BASE}${url}`;
  const { creative, cast } = await parseCredits(ctx, detailUrl);

  const premiere = group.item.premiere ? performances[0]?.date : null;

  return {
    source_production_id: url,
    work_title: cleanText(item.title),
    composer_name: composer,
    presentation_note: cleanText(item.excerpt) || null,
    premiere_date: (premiere as IsoDate | undefined) ?? null,
    detail_url: detailUrl,
    creative_team: creative,
    cast,
    performances,
  };
}

/** The "Besetzung" accordion is repeated `<div>` blocks: a bare German label
 *  text node followed by one or more `<a href="/de/personen/{slug}/">NAME</a>`.
 *  A mapped function → creative; anything else is treated as a sung role. */
async function parseCredits(
  ctx: FetchContext,
  detailUrl: string,
): Promise<{ creative: RawCredit[]; cast: RawCredit[] }> {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  let html: string;
  try {
    html = await fetchHtml(detailUrl, ctx);
  } catch (err) {
    console.warn(`stadttheater-giessen: detail ${detailUrl} failed:`, err);
    return { creative, cast };
  }

  const start = html.indexOf("accordion-item-persons");
  if (start < 0) return { creative, cast };
  const section = html.slice(start, start + 30000);

  const block =
    /<div>\s*([^<]+?)\s*((?:<a[^>]*href="\/de\/personen\/[^>]*>[^<]*<\/a>\s*)+)<\/div>/g;
  for (const m of section.matchAll(block)) {
    const label = decodeEntities((m[1] ?? "").trim());
    if (!label) continue;
    const names = [...(m[2] ?? "").matchAll(/href="\/de\/personen\/[^"]+">([^<]*)<\/a>/g)]
      .map((n) =>
        decodeEntities((n[1] ?? "").trim())
          .replace(/,\s*$/, "")
          .trim(),
      )
      .filter(Boolean);
    for (const name of names) {
      const credit = normalizeGermanCredit(label, name);
      (credit.function ? creative : cast).push(credit);
    }
  }
  return { creative, cast };
}

/** Build an ISO date from the listing's "DD.MM." (no year) plus the request year. */
function isoDate(ddmm: string | undefined, year: number): IsoDate | null {
  const m = ddmm?.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
  if (!m) return null;
  return isoFromParts(year, m[2] ?? "", m[1] ?? "");
}

function cleanText(value: string | undefined): string {
  return value ? stripHtml(value) : "";
}

/** Advance a "YYYY-MM" string by n months. */
function addMonths(yyyymm: string, n: number): string {
  const [y, m] = yyyymm.split("-").map(Number);
  const total = (y ?? 0) * 12 + (m ?? 1) - 1 + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}
