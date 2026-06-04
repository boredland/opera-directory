import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Theater Bonn (`json-api` strategy).
 *
 * A Django/Vue SPA over a REST API (base `/de/api`). `/de/api/repertoire/` lists
 * the productions with a `categories` array (filter to "Oper") and a `description`
 * whose first `<span class="small-caps">` is the composer, followed by
 * "Label: <span class="small-caps">Name</span>" creative-team pairs.
 * `/de/api/events/` lists every performance with the production `url`,
 * `date_full` (DD.MM.YYYY) and `date_time` ("HH:MM Uhr") — group by `url` for the
 * dates. There is no per-production detail endpoint, so the sung cast (rendered
 * client-side) is left empty. Future-only → Wikidata backfill for the archive.
 */

const BASE = "https://www.theater-bonn.de";
/** Theater Bonn on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q833954";

interface BonnItem {
  id?: number;
  url?: string;
  title?: string;
  description?: string;
  categories?: string[];
  date_full?: string;
  date_time?: string;
}

export async function scrapeTheaterBonn(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const [repertoire, events] = await Promise.all([
    fetchJson<BonnItem[]>(`${BASE}/de/api/repertoire/`, ctx),
    fetchJson<BonnItem[]>(`${BASE}/de/api/events/`, ctx),
  ]);

  const datesByUrl = new Map<string, RawPerformance[]>();
  const today = new Date().toISOString().slice(0, 10);
  for (const e of events) {
    if (!e.url || !e.date_full) continue;
    const date = isoFromDmy(e.date_full);
    if (!date) continue;
    if (window.since && date < window.since) continue;
    const time = e.date_time?.match(/(\d{1,2}:\d{2})/)?.[1] ?? null;
    const list = datesByUrl.get(e.url) ?? [];
    list.push({ date, time, status: date < today ? "past" : "scheduled" });
    datesByUrl.set(e.url, list);
  }

  const productions: RawProduction[] = [];
  for (const item of repertoire) {
    if (!item.url || !item.title || !(item.categories ?? []).includes("Oper")) continue;
    const performances = dedupePerformances(datesByUrl.get(item.url) ?? []);
    if (performances.length === 0) continue;
    const { composer, creative_team } = parseDescription(item.description ?? "");
    productions.push({
      source_production_id: item.url.split("/").filter(Boolean).pop() ?? item.url,
      work_title: stripHtml(item.title),
      composer_name: composer,
      detail_url: `${BASE}${item.url}`,
      creative_team,
      cast: [],
      performances,
    });
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-bonn: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-bonn", productions };
}

/** Description HTML: first small-caps span = composer; later "Label: <span small-caps>Name</span>"
 *  pairs = creative team (German labels). */
function parseDescription(html: string): { composer: string | null; creative_team: RawCredit[] } {
  const composer =
    stripHtml(html.match(/<span class="small-caps">\s*([^<]+?)\s*<\/span>/)?.[1] ?? "") || null;

  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /([A-Za-zÄÖÜ][A-Za-zÄÖÜ .-]*?):\s*(?:&nbsp;|\s)*<span class="small-caps">\s*([^<]+?)\s*<\/span>/g,
  )) {
    const label = decodeEntities(m[1] ?? "")
      .split("|")
      .pop()
      ?.trim();
    const name = stripHtml(m[2] ?? "");
    if (!label || !name) continue;
    const credit = normalizeGermanCredit(label, name);
    if (!credit.function) continue; // keep mapped creative functions only
    const key = `${credit.function}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creative_team.push(credit);
  }
  return { composer, creative_team };
}

function dedupePerformances(perfs: RawPerformance[]): RawPerformance[] {
  const seen = new Set<string>();
  return perfs
    .filter((p) => {
      const key = `${p.date}|${p.time ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}

function isoFromDmy(dmy: string): IsoDate | null {
  const m = dmy.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? (`${m[3]}-${m[2]}-${m[1]}` as IsoDate) : null;
}
