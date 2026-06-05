import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";

/**
 * Anhaltisches Theater Dessau (`json-api` strategy).
 *
 * Vite SPA over a custom JSON API. `/api/termine` returns a flat array of every
 * performance with `genre` (filter to Oper/Operette/Musical), `titel`,
 * `stueck_l1`/`stueck_l2` (form + composer lines), `beginn` (ISO), `ort`, and
 * `stueck_kuerzel` (production slug). Group by slug. Future-only → Wikidata backfill.
 */

const API = "https://anhaltisches-theater.de/api/termine";
/** Anhaltisches Theater on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q118583186";
const OPERA = new Set(["Oper", "Operette", "Musical"]);

interface Termin {
  genre?: string;
  titel?: string;
  untertitel?: string;
  stueck_l1?: string;
  stueck_l2?: string;
  beginn?: string;
  ort?: string;
  stueck_kuerzel?: string;
}

export async function scrapeAnhaltischesTheaterDessau(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const productions: RawProduction[] = [];
  try {
    const data = await fetchJson<Termin[] | { data?: Termin[] }>(API, ctx);
    const termine = Array.isArray(data) ? data : (data.data ?? []);
    const bySlug = new Map<string, { t: Termin; perfs: RawPerformance[] }>();
    for (const t of termine) {
      if (!OPERA.has(t.genre ?? "") || !t.stueck_kuerzel) continue;
      const iso = t.beginn?.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (!iso) continue;
      const date = iso[1] as IsoDate;
      if (window.since && date < window.since) continue;
      let entry = bySlug.get(t.stueck_kuerzel);
      if (!entry) {
        entry = { t, perfs: [] };
        bySlug.set(t.stueck_kuerzel, entry);
      }
      entry.perfs.push({
        date,
        time: iso[2] ?? null,
        venue_room: t.ort ?? null,
        status: date < today ? "past" : "scheduled",
      });
    }
    for (const [slug, { t, perfs }] of bySlug) {
      if (!t.titel) continue;
      perfs.sort(
        (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
      );
      productions.push({
        source_production_id: slug,
        work_title: stripHtml(t.titel),
        composer_name: parseComposer(t),
        detail_url: `https://anhaltisches-theater.de/${slug}`,
        performances: perfs,
      });
    }
  } catch (err) {
    console.warn("anhaltisches-theater-dessau: api failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("anhaltisches-theater-dessau: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "anhaltisches-theater-dessau", productions };
}

/** The composer is the "… von {Composer}" line among stueck_l1/stueck_l2. */
function parseComposer(t: Termin): string | null {
  for (const line of [t.stueck_l1, t.stueck_l2, t.untertitel]) {
    const m = stripHtml(line ?? "").match(/\bvon\s+([A-ZÄÖÜ][^,]+?)(?:\s+nach\b|,|$)/);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}
