import { DEFAULT_UA, type FetchContext, HOUSE_SCRAPERS } from "@opera-directory/scrapers";

export * from "./resolve";

/**
 * The pipeline, end to end:
 *
 *   houses.json ─▶ scrape (per-house adapter) ─▶ normalize (Raw* rows)
 *              ─▶ resolve (link to canonical Work/Person/Role via Wikidata)
 *              ─▶ upsert (idempotent, keyed on the stable-identity rules)
 *              ─▶ persist (committed JSON under data/ — the diff-reviewable
 *                 source of truth; a SQLite/D1 read-copy is derived from it
 *                 later, only when performance-table scale demands it)
 *
 * Idempotency is the whole game: every run re-scrapes future + a rolling window
 * of recent past, and upserts. Re-running must converge, never duplicate. The
 * stable-id rules in @opera-directory/schema are what make that hold.
 */

export function makeFetchContext(): FetchContext {
  const proxyUrl = process.env.FETCH_PROXY_URL;
  return {
    proxy: proxyUrl ? { url: proxyUrl, token: process.env.FETCH_PROXY_TOKEN } : null,
    userAgent: DEFAULT_UA,
  };
}

export async function runScrape(houseSlugs?: string[]): Promise<void> {
  const ctx = makeFetchContext();
  const slugs = houseSlugs ?? Object.keys(HOUSE_SCRAPERS);
  for (const slug of slugs) {
    const scraper = HOUSE_SCRAPERS[slug];
    if (!scraper) {
      console.warn(`no adapter registered for house "${slug}", skipping`);
      continue;
    }
    try {
      const result = await scraper(ctx);
      console.log(`${slug}: ${result.productions.length} productions`);
      // TODO(implementer): resolve → upsert → persist.
    } catch (err) {
      console.error(`${slug} scrape failed:`, err);
    }
  }
}

if (import.meta.main) {
  await runScrape(process.argv.slice(2).filter((a) => !a.startsWith("-")));
}
