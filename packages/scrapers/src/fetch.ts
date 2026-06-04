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

export async function fetchHtml(url: string, ctx: FetchContext): Promise<string> {
  const res = await proxyFetch(url, ctx.proxy, {
    headers: { "User-Agent": ctx.userAgent, "Accept-Language": "de,en;q=0.8" },
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} → ${res.status}`);
  return res.text();
}

/** Fetch and parse JSON — for API strategies (Wikidata SPARQL, Spektrix, Tessitura). */
export async function fetchJson<T = unknown>(
  url: string,
  ctx: FetchContext,
  accept = "application/json",
): Promise<T> {
  const res = await proxyFetch(url, ctx.proxy, {
    headers: { "User-Agent": ctx.userAgent, Accept: accept },
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Headless render (last resort for client-rendered SPAs) ──────────────────
//
// Most houses are reachable with plain fetch (cheapest) or a discovered JSON API
// (see scripts/discover-api.mjs). A few (Stuttgart, Komische Oper, Hamburg) draw
// their spielplan into the DOM entirely client-side with no API or inline state,
// so the only way to read them is to run their JS. `renderHtml` does that with a
// single shared headless browser (playwright-core, lazily imported so non-render
// adapters never load it). Adapters that use it must call `closeBrowser()` when
// done — `runScrape` does this in a finally.

// biome-ignore lint/suspicious/noExplicitAny: playwright-core types loaded lazily
let _browser: any = null;
// biome-ignore lint/suspicious/noExplicitAny: playwright-core types loaded lazily
let _context: any = null;

async function ensureContext(userAgent: string) {
  if (_context && _browser?.isConnected()) return _context;
  const { chromium } = await import("playwright-core");
  _browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome-stable",
    headless: true,
  });
  _context = await _browser.newContext({ userAgent });
  return _context;
}

/** Load a page in a headless browser and return its rendered HTML after JS runs.
 *  Retries once if the shared browser has crashed (relaunches it). */
export async function renderHtml(
  url: string,
  ctx: FetchContext,
  opts: { waitForSelector?: string; waitMs?: number } = {},
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
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
      return await page.content();
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
