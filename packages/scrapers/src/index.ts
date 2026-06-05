import { scrapeAaltoMusiktheaterEssen } from "./houses/aalto-musiktheater-essen";
import { scrapeBadischesStaatstheaterKarlsruhe } from "./houses/badisches-staatstheater-karlsruhe";
import { scrapeBayerischeStaatsoper } from "./houses/bayerische-staatsoper";
import { scrapeDeutscheOperAmRhein } from "./houses/deutsche-oper-am-rhein";
import { scrapeDeutscheOperBerlin } from "./houses/deutsche-oper-berlin";
import { scrapeKomischeOperBerlin } from "./houses/komische-oper-berlin";
import { scrapeMetropolitanOpera } from "./houses/metropolitan-opera";
import { scrapeNationaltheaterMannheim } from "./houses/nationaltheater-mannheim";
import { scrapeOperDortmund } from "./houses/oper-dortmund";
import { scrapeOperFrankfurt } from "./houses/oper-frankfurt";
import { scrapeOperKoeln } from "./houses/oper-koeln";
import { scrapeOperLeipzig } from "./houses/oper-leipzig";
import { scrapeSemperoperDresden } from "./houses/semperoper-dresden";
import { scrapeStaatsoperBerlin } from "./houses/staatsoper-berlin";
import { scrapeStaatsoperHamburg } from "./houses/staatsoper-hamburg";
import { scrapeStaatsoperHannover } from "./houses/staatsoper-hannover";
import { scrapeStaatsoperStuttgart } from "./houses/staatsoper-stuttgart";
import { scrapeStaatstheaterNuernberg } from "./houses/staatstheater-nuernberg";
import { scrapeStaatstheaterWiesbaden } from "./houses/staatstheater-wiesbaden";
import { scrapeTheaterBonn } from "./houses/theater-bonn";
import { scrapeTheaterBremen } from "./houses/theater-bremen";
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
  "deutsche-oper-am-rhein": scrapeDeutscheOperAmRhein,
  "nationaltheater-mannheim": scrapeNationaltheaterMannheim,
  "oper-leipzig": scrapeOperLeipzig,
  "staatsoper-hannover": scrapeStaatsoperHannover,
  "theater-bremen": scrapeTheaterBremen,
  "aalto-musiktheater-essen": scrapeAaltoMusiktheaterEssen,
  "staatstheater-wiesbaden": scrapeStaatstheaterWiesbaden,
  "staatstheater-nuernberg": scrapeStaatstheaterNuernberg,
  "oper-dortmund": scrapeOperDortmund,
  "theater-bonn": scrapeTheaterBonn,
  "badisches-staatstheater-karlsruhe": scrapeBadischesStaatstheaterKarlsruhe,
  "bayerische-staatsoper": scrapeBayerischeStaatsoper,
};
