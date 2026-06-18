import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IsoDate } from "@opera-directory/schema";
import {
  closeBrowser,
  DEFAULT_UA,
  type FetchContext,
  fetchStatsSummary,
  HOUSE_SCRAPERS,
  type HouseScrapeResult,
  type ScrapeWindow,
} from "@opera-directory/scrapers";
import { prune } from "./prune";
import { ingestRawProduction } from "./resolve";
import { CanonicalStore } from "./store";
import { validateData } from "./validate";

export interface HealthRecord {
  slug: string;
  productions: number;
  performances: number;
  ok: boolean;
  error?: string;
}

export interface HealthSummary {
  total: number;
  zeros: number;
  errored: number;
  lines: string[];
}

export function summarizeHealth(records: HealthRecord[]): HealthSummary {
  const sorted = [...records].sort((a, b) => a.productions - b.productions);
  const lines = sorted.map((r) => {
    const status = r.error ? "ERROR" : r.productions === 0 ? "ZERO" : "ok";
    const detail = r.error ? ` (${r.error})` : "";
    return `  ${status.padEnd(5)}  ${String(r.productions).padStart(4)} prod  ${String(r.performances).padStart(5)} perf  ${r.slug}${detail}`;
  });
  return {
    total: records.length,
    zeros: records.filter((r) => r.productions === 0 && !r.error).length,
    errored: records.filter((r) => !!r.error).length,
    lines,
  };
}

export * from "./prune";
export * from "./resolve";
export * from "./store";
export * from "./validate";

/**
 * The pipeline, end to end:
 *
 *   houses.json ─▶ scrape (per-house adapter) ─▶ Raw* rows  (parallelizable)
 *              ─▶ resolve (link to canonical Work/Person/Role)
 *              ─▶ upsert  (idempotent, keyed on the stable-identity rules)
 *              ─▶ persist (committed JSON under data/ — diff-reviewable truth)
 *
 * Two ways to run it:
 *   - `runScrape` — scrape + resolve + persist in one process (local / simple).
 *   - `runScrapeRaw` (per house) → `runIngestRaw` (central) — the CI split: each
 *     house scrapes on its own runner and emits raw/<slug>.json; one ingest job
 *     then resolves the union. Safe because resolution is DETERMINISTIC — every
 *     slug is a pure function of the input, so the cross-house graph falls out of
 *     the union in any order, and a single writer keeps the commit conflict-free.
 *
 * Idempotency is the whole game: re-running converges, never duplicates.
 */

/**
 * The fetch proxy is a per-house opt-in fallback (for hosts that block datacenter
 * IPs / gate behind Cloudflare), not the default — working houses fetch directly.
 * Pass `useProxy` true only for houses with `"proxy": true` in houses.json.
 */
export function makeFetchContext(useProxy = false): FetchContext {
  const proxyUrl = process.env.FETCH_PROXY_URL;
  return {
    proxy: useProxy && proxyUrl ? { url: proxyUrl, token: process.env.FETCH_PROXY_TOKEN } : null,
    userAgent: DEFAULT_UA,
  };
}

/** Read the per-house `proxy` opt-in flag from houses.json. */
async function houseUsesProxy(slug: string): Promise<boolean> {
  try {
    const houses = JSON.parse(await readFile(join(DATA_DIR, "houses.json"), "utf8")) as {
      slug: string;
      proxy?: boolean;
    }[];
    return houses.find((h) => h.slug === slug)?.proxy === true;
  } catch {
    return false;
  }
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
 * `[house-slug …] [--backfill] [--since=YYYY-MM-DD]`
 *   (no flags)            → incremental: future + last 45 days
 *   --backfill            → walk the full archive (since = null, unbounded)
 *   --backfill --since=X  → walk the archive back to X
 *   --since=X (alone)     → incremental floored at X
 */
export function parseArgs(argv: string[]): { slugs: string[]; window: ScrapeWindow } {
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
const RAW_DIR = process.env.RAW_DIR ?? join(process.cwd(), "raw");

const HEALTH_DIR = join(RAW_DIR, "_health");

async function writeHealthRecord(record: HealthRecord): Promise<void> {
  await mkdir(HEALTH_DIR, { recursive: true });
  await writeFile(join(HEALTH_DIR, `${record.slug}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

/** Scrape one house and write its raw result to raw/<slug>.json — no resolve. */
export async function runScrapeRaw(slug: string, window?: ScrapeWindow): Promise<void> {
  const scraper = HOUSE_SCRAPERS[slug];
  if (!scraper) throw new Error(`no adapter registered for house "${slug}"`);
  const ctx = makeFetchContext(await houseUsesProxy(slug));
  const start = performance.now();
  try {
    let result: HouseScrapeResult;
    try {
      result = await scraper(ctx, window ?? defaultIncrementalWindow());
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await writeHealthRecord({
        slug,
        productions: 0,
        performances: 0,
        ok: false,
        error: errorMsg,
      });
      throw err;
    }
    const productions = result.productions.length;
    const performances = result.productions.reduce((sum, p) => sum + p.performances.length, 0);
    await mkdir(RAW_DIR, { recursive: true });
    await writeFile(join(RAW_DIR, `${slug}.json`), `${JSON.stringify(result, null, 2)}\n`);
    await writeHealthRecord({ slug, productions, performances, ok: productions > 0 });
    const secs = ((performance.now() - start) / 1000).toFixed(1);
    console.log(`${slug}: ${result.productions.length} productions in ${secs}s → raw/${slug}.json`);
    console.log(`  requests: ${fetchStatsSummary()}`);
  } finally {
    await closeBrowser();
  }
}

/** Read all raw/_health/<slug>.json records and print a summary table. */
export async function runScrapeReport(strict = false): Promise<void> {
  const healthDir = join(RAW_DIR, "_health");
  let files: string[];
  try {
    files = (await readdir(healthDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    console.log("No health records found (run scrape-raw first).");
    return;
  }
  const records: HealthRecord[] = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(healthDir, f), "utf8")) as HealthRecord),
  );
  const { total, zeros, errored, lines } = summarizeHealth(records);
  console.log("Scrape health report:");
  for (const line of lines) console.log(line);
  console.log(`\n${total} houses, ${zeros} returned 0, ${errored} errored`);
  if (strict && (zeros > 0 || errored > 0)) process.exit(1);
}

/** Resolve every raw/<slug>.json into the canonical store and persist once. */
export async function runIngestRaw(): Promise<void> {
  const store = await CanonicalStore.load(DATA_DIR);
  // Sorted for a deterministic merge order → byte-identical commits regardless of
  // which scrape runner finished first (mergeFill is first-write-wins).
  // readdir is non-recursive so raw/_health/ entries never appear; the .json
  // filter on file names (not dirs) makes the guard explicit regardless.
  const files = (await readdir(RAW_DIR)).filter((f) => f.endsWith(".json")).sort();
  for (const file of files) {
    const result = JSON.parse(await readFile(join(RAW_DIR, file), "utf8")) as HouseScrapeResult;
    for (const raw of result.productions) ingestRawProduction(store, raw, result.house_slug);
    console.log(`${result.house_slug}: ${result.productions.length} productions resolved`);
  }
  await store.save(DATA_DIR);
  console.log("store:", store.counts());
}

/** Scrape + resolve + persist in one process (local / all-in-one). */
export async function runScrape(houseSlugs?: string[], window?: ScrapeWindow): Promise<void> {
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
        const ctx = makeFetchContext(await houseUsesProxy(slug));
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
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "scrape-raw") {
    const { slugs, window } = parseArgs(rest);
    const slug = slugs[0];
    if (!slug) throw new Error("scrape-raw needs a house slug");
    await runScrapeRaw(slug, window);
  } else if (cmd === "scrape-report") {
    await runScrapeReport(rest.includes("--strict"));
  } else if (cmd === "ingest-raw") {
    await runIngestRaw();
  } else if (cmd === "validate") {
    const report = await validateData(DATA_DIR);
    for (const w of report.warnings) console.warn("⚠", w);
    for (const e of report.errors) console.error("✗", e);
    console.log("validate:", report.counts);
    if (report.errors.length) {
      console.error(
        `\n${report.errors.length} referential-integrity error(s) — the data graph is broken.`,
      );
      process.exit(1);
    }
    console.log(
      `OK — ${report.counts.persons} persons, ${report.counts.works} works, ${report.warnings.length} sanity warning(s).`,
    );
  } else if (cmd === "prune") {
    const apply = process.argv.includes("--apply");
    const report = await prune(DATA_DIR, apply);
    console.log("orphans:", report.counts);
    for (const [kind, list] of Object.entries(report.orphans)) {
      if (list.length)
        console.log(
          `  ${kind} (${list.length}): ${list.slice(0, 10).join(", ")}${list.length > 10 ? " …" : ""}`,
        );
    }
    console.log(apply ? "pruned + saved." : "dry-run — pass --apply to remove.");
  } else {
    const { slugs, window } = parseArgs(process.argv.slice(2));
    await runScrape(slugs, window);
  }
}
