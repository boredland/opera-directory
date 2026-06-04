import { makeTheaterCmsScraper } from "./_theater-cms";

/**
 * Deutsche Oper am Rhein (Düsseldorf / Duisburg) — same shared German-theatre CMS
 * as Komische Oper (see _theater-cms.ts).
 */
export const scrapeDeutscheOperAmRhein = makeTheaterCmsScraper({
  houseSlug: "deutsche-oper-am-rhein",
  baseUrl: "https://www.operamrhein.de",
  wikidataQid: "Q523473",
});
