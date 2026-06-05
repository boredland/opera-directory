import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
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
 * Theater Koblenz (`json-api`; WordPress + Leporello plugin).
 *
 * The spielplan is fed by `/wp-json/leporello/v1/items`, which returns ALL
 * announced future performances in one bare call — passing any filter param
 * makes it 500, so it's called with no query string. The payload groups items
 * by day (`days[].date` is already ISO); we keep only `segment.label ===
 * "Musiktheater"` (drops Schauspiel/Ballett/Musical/Puppentheater/etc.) and group
 * the surviving items by `permalink` into productions. The composer comes from the
 * item `subtitle` ("Oper von {Composer}"); the per-night date is the parent day's
 * date + the item's `startTime`.
 *
 * Cast + creative come from each production's detail page: two `.s-cast__employees`
 * blocks (sung cast then creative team) of repeated `.s-cast__role` rows, each a
 * `.s-cast__role-label` + `.s-cast__role-person` names. normalizeGermanCredit sorts
 * each row into a function (creative_team) or a sung role (cast). The detail page
 * also carries an unrelated global date widget — we never read dates from it; the
 * JSON is the only date source. Future-only → Wikidata backfill for history.
 */

const BASE = "https://theater-koblenz.de";
const ITEMS_URL = `${BASE}/wp-json/leporello/v1/items`;
/** Theater Koblenz on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415831";
const OPERA_SEGMENT = "Musiktheater";

interface LeporelloItem {
  title?: string;
  subtitle?: string;
  startTime?: string;
  location?: string;
  permalink?: string;
  segment?: { label?: string } | null;
  ticketUrl?: string | null;
}
interface LeporelloDay {
  date?: string;
  items?: LeporelloItem[];
}
interface LeporelloResponse {
  days?: LeporelloDay[];
}

export async function scrapeTheaterKoblenz(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    productions.push(...(await scrapeLive(ctx, window)));
  } catch (err) {
    console.warn("theater-koblenz: live api failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-koblenz: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-koblenz", productions };
}

interface Grouped {
  title: string;
  subtitle: string;
  perfs: RawPerformance[];
}

async function scrapeLive(ctx: FetchContext, window: ScrapeWindow): Promise<RawProduction[]> {
  const today = new Date().toISOString().slice(0, 10);
  const data = await fetchJson<LeporelloResponse>(ITEMS_URL, ctx);

  const byPermalink = new Map<string, Grouped>();
  for (const day of data.days ?? []) {
    const date = day.date;
    if (!date) continue;
    if (window.since && date < window.since) continue;
    for (const item of day.items ?? []) {
      if ((item.segment?.label ?? "").trim() !== OPERA_SEGMENT) continue;
      const permalink = item.permalink?.trim();
      const title = item.title?.trim();
      if (!permalink || !title) continue;

      let entry = byPermalink.get(permalink);
      if (!entry) {
        entry = { title, subtitle: item.subtitle?.trim() ?? "", perfs: [] };
        byPermalink.set(permalink, entry);
      }
      const time = item.startTime?.trim() || null;
      if (!entry.perfs.some((p) => p.date === date && p.time === time)) {
        entry.perfs.push({
          date: date as IsoDate,
          time,
          venue_room: item.location?.trim() || null,
          status: date < today ? "past" : "scheduled",
          ticket_url: item.ticketUrl ?? null,
        });
      }
    }
  }

  const out: RawProduction[] = [];
  for (const [permalink, p] of byPermalink) {
    if (p.perfs.length === 0) continue;
    p.perfs.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
    const { cast, creative } = await fetchCredits(ctx, permalink);
    out.push({
      source_production_id: slugFromUrl(permalink),
      work_title: p.title,
      // The subtitle is "·"-separated ("Kammeroper von X · Libretto von …"); the
      // composer lives in the first segment.
      composer_name: composerFromText(p.subtitle.split("·")[0] ?? p.subtitle),
      detail_url: permalink,
      ...(creative.length ? { creative_team: creative } : {}),
      ...(cast.length ? { cast } : {}),
      performances: p.perfs,
    });
  }
  return out;
}

/**
 * Read the detail page's `.s-cast__employees` blocks (sung cast then creative
 * team) and split each `.s-cast__role` row via normalizeGermanCredit. Rows with an
 * empty label (alternate-cast continuations) or empty person nodes (chorus avatars)
 * are skipped. Dates on this page belong to an unrelated widget and are ignored.
 */
async function fetchCredits(
  ctx: FetchContext,
  url: string,
): Promise<{ cast: RawCredit[]; creative: RawCredit[] }> {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  try {
    const html = await fetchHtml(url, ctx);
    for (const block of html.split("s-cast__employees").slice(1)) {
      for (const row of block.split("s-cast__role-label").slice(1)) {
        // The split lands mid-tag (`"> {label} </p>`); take the text inside the <p>.
        const label = stripHtml((row.match(/>([\s\S]*?)<\/p>/) ?? [])[1] ?? "");
        if (!label) continue;
        for (const m of row.matchAll(/s-cast__role-person"[^>]*>([\s\S]*?)<\//g)) {
          const name = stripHtml(m[1] ?? "");
          if (!name) continue;
          const credit = normalizeGermanCredit(label, name);
          (credit.function ? creative : cast).push(credit);
        }
      }
    }
  } catch (err) {
    console.warn(`theater-koblenz: detail ${url} failed:`, err);
  }
  return { cast, creative };
}

function slugFromUrl(url: string): string {
  return (
    url
      .replace(/[?#].*$/, "")
      .replace(/\/$/, "")
      .split("/")
      .pop() || url
  );
}
