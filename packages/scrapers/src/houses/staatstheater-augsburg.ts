import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchJson } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Staatstheater Augsburg (`json-api` strategy).
 *
 * A Vue SPA over a public CouchDB view. `_design/spieltermine/_view/by_datum_public_2`
 * returns one doc per performance (`sorte: "spieltermin"`) with `thea_genre`
 * (filter to Oper/Musiktheater), `thea_titel`, `thea_autor` (composer), `beginn`
 * (ISO datetime), `thea_link` (production slug) and venue fields. Group by slug.
 * Future-only → Wikidata backfill.
 */

const VIEW =
  "https://staatstheater-augsburg.de/theater-augsburg/_design/spieltermine/_view/by_datum_public_2";
/** Staatstheater Augsburg on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1441463";
/** Augsburg files opera under the genre code "MT" (Musiktheater). */
const OPERA = /^(MT|Oper|Operette|Musiktheater)$/i;

interface AugsburgDoc {
  sorte?: string;
  thea_genre?: string;
  thea_titel?: string;
  thea_autor?: string;
  thea_kurztext1?: string;
  beginn?: string;
  thea_link?: string;
  thea_ort?: string;
  thea_veranstaltungs_kategorie?: string;
}
interface ViewResp {
  rows?: { doc?: AugsburgDoc }[];
}

export async function scrapeStaatstheaterAugsburg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const url = `${VIEW}?include_docs=true&startkey=${encodeURIComponent(`"${today}"`)}&limit=4000`;
  const productions: RawProduction[] = [];
  try {
    const res = await fetchJson<ViewResp>(url, ctx);
    const bySlug = new Map<string, { doc: AugsburgDoc; perfs: RawPerformance[] }>();
    for (const row of res.rows ?? []) {
      const d = row.doc;
      if (d?.sorte !== "spieltermin" || !OPERA.test((d.thea_genre ?? "").trim())) continue;
      const slug = d.thea_link;
      const iso = d.beginn?.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (!slug || !iso) continue;
      const date = iso[1] as IsoDate;
      if (window.since && date < window.since) continue;
      let entry = bySlug.get(slug);
      if (!entry) {
        entry = { doc: d, perfs: [] };
        bySlug.set(slug, entry);
      }
      entry.perfs.push({
        date,
        time: iso[2] ?? null,
        venue_room: d.thea_ort ?? null,
        status: date < today ? "past" : "scheduled",
      });
    }
    for (const [slug, { doc, perfs }] of bySlug) {
      if (!doc.thea_titel) continue;
      perfs.sort(
        (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
      );
      productions.push({
        source_production_id: slug,
        work_title: doc.thea_titel.trim(),
        composer_name: composerFromText(doc.thea_kurztext1 ?? "") ?? doc.thea_autor?.trim() ?? null,
        detail_url: `https://staatstheater-augsburg.de/${slug}`,
        performances: perfs,
      });
    }
  } catch (err) {
    console.warn("staatstheater-augsburg: api failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatstheater-augsburg: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatstheater-augsburg", productions };
}
