import { scrapeDeutscheOperBerlin } from "./houses/deutsche-oper-berlin";
import { scrapeKomischeOperBerlin } from "./houses/komische-oper-berlin";
import { scrapeMetropolitanOpera } from "./houses/metropolitan-opera";
import { scrapeOperFrankfurt } from "./houses/oper-frankfurt";
import { scrapeOperKoeln } from "./houses/oper-koeln";
import { scrapeSemperoperDresden } from "./houses/semperoper-dresden";
import { scrapeStaatsoperBerlin } from "./houses/staatsoper-berlin";
import { scrapeStaatsoperHamburg } from "./houses/staatsoper-hamburg";
import { scrapeStaatsoperStuttgart } from "./houses/staatsoper-stuttgart";
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
  "metropolitan-opera": scrapeMetropolitanOpera,
  "staatsoper-berlin": scrapeStaatsoperBerlin,
  "oper-koeln": scrapeOperKoeln,
  "semperoper-dresden": scrapeSemperoperDresden,
  "deutsche-oper-berlin": scrapeDeutscheOperBerlin,
  "staatsoper-stuttgart": scrapeStaatsoperStuttgart,
  "staatsoper-hamburg": scrapeStaatsoperHamburg,
  "komische-oper-berlin": scrapeKomischeOperBerlin,
};
