import type { IsoDate } from "@opera-directory/schema";
import type { FetchContext } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";

/**
 * Staatstheater Kassel (`json-api` strategy).
 *
 * Nuxt SPA over a public Strapi GraphQL backend. The frontend HTML is an empty
 * shell, so we query GraphQL directly: `events` joins `Play` → `Production`, where
 * `Play.Section_1` is the division (filter to "Musiktheater"), `Production.Writer`
 * is the composer, `Event.StartDate` (UTC ISO) the performance time. Group by
 * `Play.Slug`. Future-only → Wikidata backfill.
 */

const GRAPHQL = "https://backend.staatstheater-kassel.de/graphql";
/** Staatstheater Kassel on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q579534";

interface KasselEvent {
  StartDate?: string;
  Location?: string;
  Play?: {
    Title?: string;
    Slug?: string;
    Section_1?: string;
    Production?: { Writer?: string };
  };
}

export async function scrapeStaatstheaterKassel(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const query = `query { events(where: { StartDate_gte: "${window.since ?? today}T00:00:00.000Z" }, sort: "StartDate:asc", limit: 2000) { StartDate Location Play { Title Slug Section_1 Production { Writer } } } }`;

  const productions: RawProduction[] = [];
  try {
    const res = await fetch(GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": ctx.userAgent },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30000),
    });
    const json = (await res.json()) as { data?: { events?: KasselEvent[] } };
    const bySlug = new Map<string, { e: KasselEvent; perfs: RawPerformance[] }>();
    for (const e of json.data?.events ?? []) {
      const play = e.Play;
      const slug = play?.Slug;
      if (!play || !slug || play.Section_1 !== "Musiktheater") continue;
      const iso = e.StartDate?.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (!iso) continue;
      const date = iso[1] as IsoDate;
      if (window.since && date < window.since) continue;
      let entry = bySlug.get(slug);
      if (!entry) {
        entry = { e, perfs: [] };
        bySlug.set(slug, entry);
      }
      entry.perfs.push({
        date,
        time: iso[2] ?? null,
        venue_room: e.Location ?? null,
        status: date < today ? "past" : "scheduled",
      });
    }
    for (const [slug, { e, perfs }] of bySlug) {
      if (!e.Play?.Title) continue;
      perfs.sort(
        (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
      );
      productions.push({
        source_production_id: slug,
        work_title: e.Play.Title.trim(),
        composer_name: e.Play.Production?.Writer?.trim() || null,
        detail_url: `https://www.staatstheater-kassel.de/stueck/${slug}`,
        performances: perfs,
      });
    }
  } catch (err) {
    console.warn("staatstheater-kassel: graphql failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatstheater-kassel: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatstheater-kassel", productions };
}
