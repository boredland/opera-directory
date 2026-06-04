import { makeTheaterCmsScraper } from "./_theater-cms";

/**
 * Komische Oper Berlin — on the shared German-theatre CMS (see _theater-cms.ts).
 * Currently playing at the Schillertheater during the Stammhaus renovation.
 */
export const scrapeKomischeOperBerlin = makeTheaterCmsScraper({
  houseSlug: "komische-oper-berlin",
  baseUrl: "https://www.komische-oper-berlin.de",
  wikidataQid: "Q687694",
});
