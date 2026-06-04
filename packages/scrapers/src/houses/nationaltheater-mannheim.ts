import { makeTheaterCmsScraper } from "./_theater-cms";

/**
 * Nationaltheater Mannheim — same shared German-theatre CMS (see _theater-cms.ts),
 * with the no-`kalender/` link variant and "… von Composer" / "Abendbesetzung:"
 * meta dialect.
 */
export const scrapeNationaltheaterMannheim = makeTheaterCmsScraper({
  houseSlug: "nationaltheater-mannheim",
  baseUrl: "https://www.nationaltheater-mannheim.de",
  wikidataQid: "Q290852",
});
