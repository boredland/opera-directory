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

export const DEFAULT_UA =
  "opera.directory crawler (+https://opera.directory/about/crawler)";

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
