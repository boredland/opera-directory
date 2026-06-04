import { makeScheduleCmsScraper } from "./_schedule-cms";

/**
 * Hessisches Staatstheater Wiesbaden. Same schedule-card CMS as Essen
 * (houses/_schedule-cms.ts), but the schedule lives under `/spielplan/`; opera
 * cards carry the category "Musiktheater".
 */
export const scrapeStaatstheaterWiesbaden = makeScheduleCmsScraper({
  houseSlug: "staatstheater-wiesbaden",
  baseUrl: "https://www.staatstheater-wiesbaden.de",
  section: "spielplan",
  wikidataQid: "Q463782",
});
