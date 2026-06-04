import { join } from "node:path";
import type { IsoDate } from "@opera-directory/schema";
import {
  closeBrowser,
  DEFAULT_UA,
  type FetchContext,
  HOUSE_SCRAPERS,
  type ScrapeWindow,
} from "@opera-directory/scrapers";
import { ingestRawProduction } from "./resolve";
import { CanonicalStore } from "./store";

export * from "./resolve";
export * from "./store";

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

/**
 * How many days of already-played performances the daily run re-fetches, so
 * late cast substitutions / cancellations land. Deep history is a separate
 * `--backfill` run, not the nightly path.
 */
const DEFAULT_RECENT_PAST_DAYS = 45;

function defaultIncrementalWindow(): ScrapeWindow {
  const floor = new Date();
  floor.setUTCDate(floor.getUTCDate() - DEFAULT_RECENT_PAST_DAYS);
  return { mode: "incremental", since: floor.toISOString().slice(0, 10) as IsoDate };
}

/**
 * `bun run scrape [house-slug …] [--backfill] [--since=YYYY-MM-DD]`
 *   (no flags)            → incremental: future + last 45 days
 *   --backfill            → walk the full archive (since = null, unbounded)
 *   --backfill --since=X  → walk the archive back to X
 *   --since=X (alone)     → incremental floored at X
 */
function parseArgs(argv: string[]): { slugs: string[]; window: ScrapeWindow } {
  const slugs: string[] = [];
  let backfill = false;
  let since: IsoDate | null = null;
  for (const arg of argv) {
    if (arg === "--backfill") backfill = true;
    else if (arg.startsWith("--since=")) since = arg.slice("--since=".length) as IsoDate;
    else if (!arg.startsWith("-")) slugs.push(arg);
  }
  const window: ScrapeWindow = backfill
    ? { mode: "backfill", since }
    : since
      ? { mode: "incremental", since }
      : defaultIncrementalWindow();
  return { slugs, window };
}

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");

export async function runScrape(houseSlugs?: string[], window?: ScrapeWindow): Promise<void> {
  const ctx = makeFetchContext();
  const scrapeWindow = window ?? defaultIncrementalWindow();
  const slugs = houseSlugs?.length ? houseSlugs : Object.keys(HOUSE_SCRAPERS);

  const store = await CanonicalStore.load(DATA_DIR);
  try {
    for (const slug of slugs) {
      const scraper = HOUSE_SCRAPERS[slug];
      if (!scraper) {
        console.warn(`no adapter registered for house "${slug}", skipping`);
        continue;
      }
      try {
        const result = await scraper(ctx, scrapeWindow);
        for (const raw of result.productions) ingestRawProduction(store, raw, result.house_slug);
        console.log(`${slug}: ${result.productions.length} productions resolved`);
      } catch (err) {
        console.error(`${slug} scrape failed:`, err);
      }
    }
  } finally {
    await closeBrowser(); // tear down the headless browser if any render adapter used it
  }
  await store.save(DATA_DIR);
  console.log("store:", store.counts());
}

if (import.meta.main) {
  const { slugs, window } = parseArgs(process.argv.slice(2));
  await runScrape(slugs, window);
}
