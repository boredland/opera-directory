import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Theater Freiburg (`json-api` / cb-event strategy).
 *
 * cb-event house. The spielplan is JS-rendered but backed by `event.json`:
 * `?m=calendar_events&p={page}&fields[category]=musictheater` returns
 * `{Results:[{Events:[…]}], IsLastPage}`. Each Event has `Title`, `DateTimeAtom`
 * (ISO), `TimeLocation`, `OpusInfoShort` ("Form von Composer"), `Slug`
 * (`/de_DE/programm/{slug}.{id}?event_date=…`). Group by slug. Future-only → Wikidata.
 */

const BASE = "https://theater.freiburg.de";
const EVENT_API = `${BASE}/de_DE/event.json?m=calendar_events&fields%5Bcategory%5D=musictheater`;
/** Theater Freiburg on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1727716";

interface FbEvent {
  Title?: string;
  DateTimeAtom?: string;
  OpusInfoShort?: string;
  Slug?: string;
  TimeLocation?: string;
}
interface FbResp {
  Results?: { Events?: FbEvent[] }[];
  IsLastPage?: boolean;
}

export async function scrapeTheaterFreiburg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const productions: RawProduction[] = [];
  try {
    const events: FbEvent[] = [];
    for (let p = 1; p <= 40; p++) {
      const res = await fetchJson<FbResp>(`${EVENT_API}&p=${p}`, ctx);
      for (const r of res.Results ?? []) events.push(...(r.Events ?? []));
      if (res.IsLastPage !== false) break;
    }
    const bySlug = new Map<string, { e: FbEvent; perfs: RawPerformance[] }>();
    for (const e of events) {
      const slug = e.Slug?.split("?")[0]
        ?.replace(/^\/de_DE\/programm\//, "")
        .replace(/\/$/, "");
      const iso = e.DateTimeAtom?.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (!slug || !iso) continue;
      const date = iso[1] as IsoDate;
      if (window.since && date < window.since) continue;
      const venue = e.TimeLocation?.split(",").slice(1).join(",").trim() || null;
      let entry = bySlug.get(slug);
      if (!entry) {
        entry = { e, perfs: [] };
        bySlug.set(slug, entry);
      }
      entry.perfs.push({
        date,
        time: iso[2] ?? null,
        venue_room: venue,
        status: date < today ? "past" : "scheduled",
      });
    }
    for (const [slug, { e, perfs }] of bySlug) {
      if (!e.Title) continue;
      perfs.sort(
        (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
      );
      productions.push({
        source_production_id: slug,
        work_title: stripHtml(e.Title),
        composer_name: composerFromText(stripHtml(e.OpusInfoShort ?? "")),
        detail_url: `${BASE}/de_DE/programm/${slug}`,
        performances: perfs,
      });
    }
  } catch (err) {
    console.warn("theater-freiburg: event.json failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-freiburg: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-freiburg", productions };
}
