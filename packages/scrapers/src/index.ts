import { scrapeOperFrankfurt } from "./houses/oper-frankfurt";
import type { HouseScraper } from "./types";

export * from "./fetch";
export * from "./types";

/**
 * Adapter registry keyed by house slug. The ingest runner walks data/houses.json,
 * looks each enabled house up here, and runs its adapter. Houses without an
 * adapter yet (strategy: "manual" / "wikidata-sparql") are absent on purpose.
 */
export const HOUSE_SCRAPERS: Record<string, HouseScraper> = {
  "oper-frankfurt": scrapeOperFrankfurt,
};
