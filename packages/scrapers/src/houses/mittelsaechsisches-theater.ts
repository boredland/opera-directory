import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, proxyFetch, stripHtml } from "../fetch";
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
 * Mittelsächsisches Theater (`json-api`, TYPO3, no proxy) — plays in Freiberg and
 * Döbeln (and the Seebühne Kriebstein open-air stage).
 *
 * The AngularJS spielplan is fed by a POST endpoint: `?type=777` with a JSON body
 * `{categories:{"2":true}, offset}` (2 = Musiktheater) returns 20 performances per
 * page (its body is JSON though the Content-Type says text/html). Each item has the
 * title, a "{genre} von {Composer}" subTitle, an ISO-ish date, room (city) and a
 * `/spielplan/{slug}-{id}` detailUri (id is per-performance → group by slug). The
 * detail page's `.avatar` cards (name + role/function label) give the cast +
 * creative team. Future-only → Wikidata backfill.
 */

const BASE = "https://www.mittelsaechsisches-theater.de";
/** Mittelsächsisches Theater on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1695492";
const MUSIKTHEATER = "2";

interface MstItem {
  date?: string;
  time?: string;
  title?: string;
  subTitle?: string;
  room?: string;
  detailUri?: string;
}
interface Grouped {
  title: string;
  composer: string | null;
  detailUri: string;
  perfs: RawPerformance[];
}

export async function scrapeMittelsaechsischesTheater(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const grouped = await walkSchedule(ctx, window);
    for (const [slug, g] of grouped) {
      if (!g.composer || g.perfs.length === 0) continue;
      const prod: RawProduction = {
        source_production_id: slug,
        work_title: g.title,
        composer_name: g.composer,
        detail_url: `${BASE}${g.detailUri}`,
        performances: g.perfs.sort(
          (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
        ),
      };
      try {
        const { cast, creative } = await fetchCredits(ctx, g.detailUri);
        prod.cast = cast;
        prod.creative_team = creative;
      } catch (err) {
        console.warn(`mittelsaechsisches-theater: credits ${slug} failed:`, err);
      }
      productions.push(prod);
    }
  } catch (err) {
    console.warn("mittelsaechsisches-theater: schedule failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("mittelsaechsisches-theater: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "mittelsaechsisches-theater", productions };
}

/** Page the type=777 endpoint (20/page) into a slug → production map. */
async function walkSchedule(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<Map<string, Grouped>> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, Grouped>();

  for (let offset = 0; offset <= 400; offset += 20) {
    const res = await proxyFetch(`${BASE}/?type=777`, ctx.proxy, {
      method: "POST",
      headers: { "User-Agent": ctx.userAgent, "Content-Type": "application/json" },
      body: JSON.stringify({
        start: "",
        categories: { [MUSIKTHEATER]: true },
        rooms: [],
        spielplan: [],
        searchPhrase: "",
        offset,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) break;
    // The body is JSON despite a text/html Content-Type → parse the text.
    let items: MstItem[];
    try {
      items = ((JSON.parse(await res.text()) as { data?: MstItem[] }).data ?? []) as MstItem[];
    } catch {
      break;
    }
    for (const item of items) addItem(bySlug, item, window, today);
    if (items.length < 20) break;
  }
  return bySlug;
}

function addItem(
  bySlug: Map<string, Grouped>,
  item: MstItem,
  window: ScrapeWindow,
  today: string,
): void {
  const uri = item.detailUri;
  const dm = item.date?.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!uri || !dm || /\bmusical\b/i.test(item.subTitle ?? "")) return;
  const date = `${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
  if (window.since && date < window.since) return;
  const slug = uri.replace(/-\d+$/, "").split("/").pop() ?? uri;
  const time = item.time?.trim() || null;

  let g = bySlug.get(slug);
  if (!g) {
    g = {
      title: stripHtml(item.title ?? ""),
      composer: composerFromText(stripHtml(item.subTitle ?? "")),
      detailUri: uri,
      perfs: [],
    };
    bySlug.set(slug, g);
  }
  if (!g.perfs.some((p) => p.date === date && p.time === time)) {
    g.perfs.push({
      date,
      time,
      venue_room: stripHtml(item.room ?? "") || null,
      status: date < today ? "past" : "scheduled",
    });
  }
}

/** Detail `.avatar` cards: name (`avatar__name`) then label (`avatar__position`),
 *  both inside one `avatar__info`. A label in the German map is a creative function,
 *  anything else a sung role. */
async function fetchCredits(
  ctx: FetchContext,
  detailUri: string,
): Promise<{ cast: RawCredit[]; creative: RawCredit[] }> {
  const html = await fetchHtml(`${BASE}${detailUri}`, ctx);
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  for (const card of html.split("avatar__info").slice(1)) {
    const name = stripHtml(card.match(/avatar__name[^>]*>([\s\S]*?)<\/h5>/)?.[1] ?? "");
    const label = stripHtml(card.match(/avatar__position[^>]*>([\s\S]*?)<\/small>/)?.[1] ?? "");
    if (!name || !label) continue;
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative.push(credit);
    else cast.push({ role: label, name });
  }
  return { cast, creative };
}
