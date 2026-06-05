import { scrapeAaltoMusiktheaterEssen } from "./houses/aalto-musiktheater-essen";
import { scrapeAnhaltischesTheaterDessau } from "./houses/anhaltisches-theater-dessau";
import { scrapeBadischesStaatstheaterKarlsruhe } from "./houses/badisches-staatstheater-karlsruhe";
import { scrapeBayerischeStaatsoper } from "./houses/bayerische-staatsoper";
import { scrapeDeutscheOperAmRhein } from "./houses/deutsche-oper-am-rhein";
import { scrapeDeutscheOperBerlin } from "./houses/deutsche-oper-berlin";
import { scrapeKomischeOperBerlin } from "./houses/komische-oper-berlin";
import { scrapeMainfrankenTheaterWuerzburg } from "./houses/mainfranken-theater-wuerzburg";
import { scrapeMecklenburgischesStaatstheater } from "./houses/mecklenburgisches-staatstheater";
import { scrapeMetropolitanOpera } from "./houses/metropolitan-opera";
import { scrapeMusiktheaterImRevier } from "./houses/musiktheater-im-revier";
import { scrapeNationaltheaterMannheim } from "./houses/nationaltheater-mannheim";
import { scrapeNationaltheaterWeimar } from "./houses/nationaltheater-weimar";
import { scrapeOperChemnitz } from "./houses/oper-chemnitz";
import { scrapeOperDortmund } from "./houses/oper-dortmund";
import { scrapeOperFrankfurt } from "./houses/oper-frankfurt";
import { scrapeOperHalle } from "./houses/oper-halle";
import { scrapeOperKoeln } from "./houses/oper-koeln";
import { scrapeOperLeipzig } from "./houses/oper-leipzig";
import { scrapeOperWuppertal } from "./houses/oper-wuppertal";
import { scrapeSaarlaendischesStaatstheater } from "./houses/saarlaendisches-staatstheater";
import { scrapeSemperoperDresden } from "./houses/semperoper-dresden";
import { scrapeStaatsoperBerlin } from "./houses/staatsoper-berlin";
import { scrapeStaatsoperHamburg } from "./houses/staatsoper-hamburg";
import { scrapeStaatsoperHannover } from "./houses/staatsoper-hannover";
import { scrapeStaatsoperStuttgart } from "./houses/staatsoper-stuttgart";
import { scrapeStaatstheaterAmGaertnerplatz } from "./houses/staatstheater-am-gaertnerplatz";
import { scrapeStaatstheaterAugsburg } from "./houses/staatstheater-augsburg";
import { scrapeStaatstheaterBraunschweig } from "./houses/staatstheater-braunschweig";
import { scrapeStaatstheaterCottbus } from "./houses/staatstheater-cottbus";
import { scrapeStaatstheaterDarmstadt } from "./houses/staatstheater-darmstadt";
import { scrapeStaatstheaterKassel } from "./houses/staatstheater-kassel";
import { scrapeStaatstheaterMainz } from "./houses/staatstheater-mainz";
import { scrapeStaatstheaterNuernberg } from "./houses/staatstheater-nuernberg";
import { scrapeStaatstheaterRegensburg } from "./houses/staatstheater-regensburg";
import { scrapeStaatstheaterWiesbaden } from "./houses/staatstheater-wiesbaden";
import { scrapeStadttheaterBremerhaven } from "./houses/stadttheater-bremerhaven";
import { scrapeTheaterAachen } from "./houses/theater-aachen";
import { scrapeTheaterBielefeld } from "./houses/theater-bielefeld";
import { scrapeTheaterBonn } from "./houses/theater-bonn";
import { scrapeTheaterBremen } from "./houses/theater-bremen";
import { scrapeTheaterErfurt } from "./houses/theater-erfurt";
import { scrapeTheaterFreiburg } from "./houses/theater-freiburg";
import { scrapeTheaterHagen } from "./houses/theater-hagen";
import { scrapeTheaterHeidelberg } from "./houses/theater-heidelberg";
import { scrapeTheaterKrefeldMoenchengladbach } from "./houses/theater-krefeld-moenchengladbach";
import { scrapeTheaterMagdeburg } from "./houses/theater-magdeburg";
import { scrapeTheaterOsnabrueck } from "./houses/theater-osnabrueck";
import { scrapeVolkstheaterRostock } from "./houses/volkstheater-rostock";
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
  "staatstheater-am-gaertnerplatz": scrapeStaatstheaterAmGaertnerplatz,
  "oper-chemnitz": scrapeOperChemnitz,
  "staatstheater-augsburg": scrapeStaatstheaterAugsburg,
  "anhaltisches-theater-dessau": scrapeAnhaltischesTheaterDessau,
  "theater-freiburg": scrapeTheaterFreiburg,
  "staatstheater-cottbus": scrapeStaatstheaterCottbus,
  "oper-halle": scrapeOperHalle,
  "staatstheater-darmstadt": scrapeStaatstheaterDarmstadt,
  "theater-erfurt": scrapeTheaterErfurt,
  "staatstheater-kassel": scrapeStaatstheaterKassel,
  "mainfranken-theater-wuerzburg": scrapeMainfrankenTheaterWuerzburg,
  "saarlaendisches-staatstheater": scrapeSaarlaendischesStaatstheater,
  "staatstheater-mainz": scrapeStaatstheaterMainz,
  "nationaltheater-weimar": scrapeNationaltheaterWeimar,
  "staatstheater-braunschweig": scrapeStaatstheaterBraunschweig,
  "staatstheater-regensburg": scrapeStaatstheaterRegensburg,
  "theater-aachen": scrapeTheaterAachen,
  "musiktheater-im-revier": scrapeMusiktheaterImRevier,
  "theater-magdeburg": scrapeTheaterMagdeburg,
  "theater-bielefeld": scrapeTheaterBielefeld,
  "mecklenburgisches-staatstheater": scrapeMecklenburgischesStaatstheater,
  "oper-wuppertal": scrapeOperWuppertal,
  "theater-hagen": scrapeTheaterHagen,
  "theater-krefeld-moenchengladbach": scrapeTheaterKrefeldMoenchengladbach,
  "theater-heidelberg": scrapeTheaterHeidelberg,
  "theater-osnabrueck": scrapeTheaterOsnabrueck,
  "stadttheater-bremerhaven": scrapeStadttheaterBremerhaven,
  "volkstheater-rostock": scrapeVolkstheaterRostock,
};
