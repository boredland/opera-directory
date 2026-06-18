import type { IsoDate, QID } from "@opera-directory/schema";
import { type FetchContext, fetchJson } from "../fetch";
import type { RawProduction, ScrapeWindow } from "../types";

/**
 * `wikidata-sparql` strategy — open-aggregator backfill for the long tail of
 * history (CC0). This is NOT a per-house adapter; it's a shared capability any
 * house can call with its QID. Two uses (README §2 Tier 0, §4):
 *   - sole source for houses with no scrapable archive
 *   - deep-past supplement for houses whose live adapter only sees the current
 *     repertoire (Oper Frankfurt calls this in `backfill` mode)
 *
 * Wikidata models the WORK as the primary object; a "production" here is really
 * "this work, premiered at this house". We surface two relations:
 *   - P4647 location of first performance = the house  → a world premiere
 *   - P272 production company = the house               → a staged production
 * with composer (P86) and first-performance date (P1191). Coverage is thin and
 * uneven across houses — treat it as resolution anchors + historical seed, not a
 * complete dataset. The work QID rides along as `source_production_id` so the
 * resolver (§4) gets an authoritative match for free.
 */

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

interface SparqlBinding {
  item: { value: string };
  itemLabel?: { value: string };
  composerLabel?: { value: string };
  composer?: { value: string };
  premiere?: { value: string };
  rel: { value: "premiere" | "production" };
}

interface SparqlResponse {
  results: { bindings: SparqlBinding[] };
}

export async function scrapeWikidataProductions(
  qid: QID,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction[]> {
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(buildQuery(qid))}`;
  const data = await fetchJson<SparqlResponse>(url, ctx, "application/sparql-results+json");

  const byWork = new Map<string, RawProduction>();
  for (const b of data.results.bindings) {
    const workQid = b.item.value.split("/").pop() ?? b.item.value;
    const title = b.itemLabel?.value?.trim();
    // Skip items Wikidata can't label (label falls back to the bare QID) — no usable title.
    if (!title || title === workQid) continue;

    const premiereDate = b.premiere ? (b.premiere.value.slice(0, 10) as IsoDate) : null;
    if (window.since && (!premiereDate || premiereDate < window.since)) continue;

    // A work may match both relations; the premiere is the more specific fact.
    const existing = byWork.get(workQid);
    if (existing && existing.is_revival === false) continue;

    byWork.set(workQid, {
      source_production_id: `wikidata:${workQid}`,
      work_title: title,
      composer_name: b.composerLabel?.value ?? null,
      premiere_date: premiereDate,
      premiere_season: seasonOf(premiereDate),
      is_revival: b.rel.value === "production",
      detail_url: `https://www.wikidata.org/wiki/${workQid}`,
      performances: premiereDate ? [{ date: premiereDate, status: "past" }] : [],
    });
  }

  return [...byWork.values()];
}

function buildQuery(qid: QID): string {
  return `
SELECT ?item ?itemLabel ?composer ?composerLabel ?premiere ?rel WHERE {
  { ?item wdt:P4647 wd:${qid} . BIND("premiere" AS ?rel) }
  UNION
  { ?item wdt:P272 wd:${qid} . BIND("production" AS ?rel) }
  OPTIONAL { ?item wdt:P86 ?composer . }
  OPTIONAL { ?item wdt:P1191 ?premiere . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en,fr,it,es". }
}`;
}

/** German opera seasons run Aug–Jul: a Feb 1943 premiere belongs to "1942/43". */
function seasonOf(date: IsoDate | null): string | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (!year || !month) return null;
  const start = month >= 8 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}
