import { makeScheduleCmsScraper } from "./_schedule-cms";

/**
 * Aalto-Theater Essen — the opera house of Theater und Philharmonie Essen.
 * Schedule-card CMS (houses/_schedule-cms.ts); the schedule lives under
 * `/programm/`, opera cards carry the category "Aalto Musiktheater".
 */
export const scrapeAaltoMusiktheaterEssen = makeScheduleCmsScraper({
  houseSlug: "aalto-musiktheater-essen",
  baseUrl: "https://www.theater-essen.de",
  section: "programm",
  wikidataQid: "Q300975",
});
