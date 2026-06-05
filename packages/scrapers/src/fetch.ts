/**
 * Fetch helpers shared by every house adapter. Carried over from the
 * museumsufer scraper toolkit: an optional fetch-proxy passthrough (for hosts
 * that block datacenter IPs) plus a JSON-LD extractor, since schema.org Event
 * markup is the single most common structured source across opera houses.
 */

export interface ProxyConfig {
  url: string;
  token?: string;
}

export interface FetchContext {
  /** Set only when FETCH_PROXY_* is configured; most adapters ignore it. */
  proxy: ProxyConfig | null;
  /** Polite default UA; override per-adapter if a host needs it. */
  userAgent: string;
}

export const DEFAULT_UA = "opera.directory crawler (+https://opera.directory/about/crawler)";

export function proxyFetch(
  targetUrl: string,
  proxy: ProxyConfig | null,
  init?: RequestInit,
): Promise<Response> {
  if (!proxy) return fetch(targetUrl, init);
  const proxyUrl = `${proxy.url}?url=${encodeURIComponent(targetUrl)}`;
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (proxy.token) headers.Authorization = `Bearer ${proxy.token}`;
  return fetch(proxyUrl, { ...init, headers });
}

// ── Request timing ──────────────────────────────────────────────────────────
//
// Network/render time dominates a scrape, so every request is timed. Per-kind
// totals + the slowest request are summarized by `fetchStatsSummary()` (the
// runner prints it per house); anything over SLOW_REQUEST_MS is logged inline so
// a single pathological URL is easy to spot in CI logs.

type RequestKind = "html" | "json" | "render";
interface KindStat {
  count: number;
  ms: number;
}
const _stats: Record<RequestKind, KindStat> & {
  slowest: { url: string; ms: number; kind: string };
} = {
  html: { count: 0, ms: 0 },
  json: { count: 0, ms: 0 },
  render: { count: 0, ms: 0 },
  slowest: { url: "", ms: 0, kind: "" },
};
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS ?? 5000);

function record(kind: RequestKind, url: string, ms: number): void {
  const stat = _stats[kind];
  stat.count++;
  stat.ms += ms;
  if (ms > _stats.slowest.ms) _stats.slowest = { url, ms, kind };
  if (ms >= SLOW_REQUEST_MS) console.warn(`  slow ${kind} ${Math.round(ms)}ms ${url}`);
}

/** One-line summary of requests made so far (per kind + slowest). */
export function fetchStatsSummary(): string {
  const part = (k: RequestKind) =>
    _stats[k].count ? `${k} ${_stats[k].count}×${Math.round(_stats[k].ms)}ms` : "";
  const parts = (["html", "json", "render"] as const).map(part).filter(Boolean);
  const s = _stats.slowest;
  const slowest = s.url ? ` | slowest ${s.kind} ${Math.round(s.ms)}ms ${s.url}` : "";
  return `${parts.join(", ") || "no requests"}${slowest}`;
}

/** Reset the timing accumulator (between houses in an all-in-one run). */
export function resetFetchStats(): void {
  _stats.html = { count: 0, ms: 0 };
  _stats.json = { count: 0, ms: 0 };
  _stats.render = { count: 0, ms: 0 };
  _stats.slowest = { url: "", ms: 0, kind: "" };
}

export async function fetchHtml(url: string, ctx: FetchContext): Promise<string> {
  const start = performance.now();
  const res = await proxyFetch(url, ctx.proxy, {
    headers: { "User-Agent": ctx.userAgent, "Accept-Language": "de,en;q=0.8" },
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} → ${res.status}`);
  const text = await res.text();
  record("html", url, performance.now() - start);
  return text;
}

/** Fetch and parse JSON — for API strategies (Wikidata SPARQL, Spektrix, Tessitura). */
export async function fetchJson<T = unknown>(
  url: string,
  ctx: FetchContext,
  accept = "application/json",
): Promise<T> {
  const start = performance.now();
  const res = await proxyFetch(url, ctx.proxy, {
    headers: { "User-Agent": ctx.userAgent, Accept: accept },
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} → ${res.status}`);
  const data = (await res.json()) as T;
  record("json", url, performance.now() - start);
  return data;
}

// ── Headless render (last resort for client-rendered SPAs) ──────────────────
//
// Most houses are reachable with plain fetch (cheapest) or a discovered JSON API
// (see scripts/discover-api.mjs) — always try those first; a surprising number of
// "SPAs" are actually server-rendered and only rehydrate (Stuttgart was one). This
// is the genuine last resort for houses that truly build the DOM client-side with
// no API or inline state. `renderHtml` runs their JS in a single shared headless
// browser (playwright-core, lazily imported so non-render adapters never load it).
// Adapters that use it must call `closeBrowser()` when done — the runner does this
// in a finally. No enabled house currently needs it.

// biome-ignore lint/suspicious/noExplicitAny: playwright-core types loaded lazily
let _browser: any = null;
// biome-ignore lint/suspicious/noExplicitAny: playwright-core types loaded lazily
let _context: any = null;

async function ensureContext(userAgent: string) {
  if (_context && _browser?.isConnected()) return _context;
  const { chromium } = await import("playwright-core");
  // Default to Playwright's own managed Chromium (installed via `playwright
  // install chromium`); CHROME_PATH overrides it with a system browser if set.
  _browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  _context = await _browser.newContext({
    userAgent,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1440, height: 900 },
  });
  // Stealth: some opera sites (e.g. Bayerische Staatsoper) serve a "maintenance"
  // fallback to anything that looks like a headless bot. Masking the standard
  // headless tells (navigator.webdriver, missing window.chrome / plugins) gets the
  // real page — verified against staatsoper.de.
  await _context.addInitScript(() => {
    // biome-ignore lint/suspicious/noExplicitAny: this closure runs in the browser, not Node
    const g: any = globalThis;
    Object.defineProperty(g.navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(g.navigator, "languages", { get: () => ["de-DE", "de", "en"] });
    Object.defineProperty(g.navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    g.chrome = { runtime: {} };
  });
  return _context;
}

/** Load a page in a headless browser and return its rendered HTML after JS runs.
 *  Retries once if the shared browser has crashed (relaunches it). */
/**
 * Get a page's *rendered* HTML, for JS-rendered SPAs (and sites that serve a
 * bot-fallback to non-browser clients). Prefers the fetch-proxy's stealth render
 * (`?render=1`) — a real Chromium on the proxy's residential IP with the anti-bot
 * tells masked, so the scraper itself needs no browser. Falls back to a local
 * headless render when no proxy is configured (dev) or the proxy render fails.
 */
export async function fetchRendered(
  url: string,
  ctx: FetchContext,
  opts: { waitMs?: number } = {},
): Promise<string> {
  const proxyUrl = process.env.FETCH_PROXY_URL;
  if (proxyUrl) {
    const start = performance.now();
    try {
      const target = `${proxyUrl}?url=${encodeURIComponent(url)}&render=1&wait=${opts.waitMs ?? 6000}`;
      const headers: Record<string, string> = { "User-Agent": ctx.userAgent };
      if (process.env.FETCH_PROXY_TOKEN)
        headers.Authorization = `Bearer ${process.env.FETCH_PROXY_TOKEN}`;
      const res = await fetch(target, { headers });
      if (!res.ok) throw new Error(`render proxy → ${res.status}`);
      const text = await res.text();
      record("render", url, performance.now() - start);
      return text;
    } catch (err) {
      console.warn(`fetchRendered: proxy render failed (${err}); falling back to local render`);
    }
  }
  return renderHtml(url, ctx, { waitMs: opts.waitMs });
}

export async function renderHtml(
  url: string,
  ctx: FetchContext,
  opts: { waitForSelector?: string; waitMs?: number } = {},
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = performance.now();
    const context = await ensureContext(ctx.userAgent);
    // biome-ignore lint/suspicious/noExplicitAny: playwright Page type loaded lazily
    let page: any;
    try {
      page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 35000 });
      if (opts.waitForSelector) {
        await page.waitForSelector(opts.waitForSelector, { timeout: 10000 }).catch(() => {});
      }
      if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
      const html = await page.content();
      record("render", url, performance.now() - start);
      return html;
    } catch (err) {
      await page?.close().catch(() => {});
      if (attempt === 0 && /closed|crash|disconnect/i.test(String(err))) {
        _browser = null;
        _context = null;
        continue; // relaunch and retry once
      }
      throw err;
    } finally {
      await page?.close().catch(() => {});
    }
  }
  throw new Error(`renderHtml: exhausted retries for ${url}`);
}

/** Tear down the shared headless browser. Safe to call when none was launched. */
export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _context = null;
  }
}

/**
 * Pull every JSON-LD blob out of a page and return the ones whose @type is an
 * Event subtype. Handles @graph wrappers and arrays. Opera houses on modern
 * CMSes (and most ticketing widgets) emit TheaterEvent / MusicEvent here with
 * performer, startDate, location, and offers already structured.
 */
export function extractEventJsonLd(html: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1];
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    for (const node of flattenGraph(parsed)) {
      if (isEventType(node)) events.push(node);
    }
  }
  return events;
}

function flattenGraph(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.flatMap(flattenGraph);
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["@graph"])) return flattenGraph(obj["@graph"]);
    return [obj];
  }
  return [];
}

function isEventType(node: Record<string, unknown>): boolean {
  const t = node["@type"];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && /Event$/.test(x));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  szlig: "ß",
  // Accented Latin letters — opera names and roles are full of them.
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  oelig: "œ",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  yuml: "ÿ",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  Oslash: "Ø",
  OElig: "Œ",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
};

/** Decode the HTML entities that actually show up in scraped German theatre pages. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name] ?? m);
}

/** Strip tags, decode entities, collapse whitespace. For turning HTML fragments into plain text. */
export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
