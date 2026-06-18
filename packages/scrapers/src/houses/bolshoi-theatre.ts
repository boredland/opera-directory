import type { IsoDate } from "@opera-directory/schema";
import { extractEventJsonLd, type FetchContext, fetchRendered, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Bolshoi Theatre, Moscow (`render` strategy, proxy-gated).
 *
 * Multi-genre house (opera + ballet) → every production is gated to opera by a
 * REQUIRED composer (a ballet detail page carries no composer-as-author byline,
 * so it drops out). The site is Russian-first with an English mirror under
 * `/en/`; we always prefer `/en/` and only map the Russian credit labels as a
 * fallback (composerFromText is German-only and deliberately unused).
 *
 * ACCESS — NOT VIABLE as of this writing. `www.bolshoi.ru` sits behind a Qrator
 * anti-DDoS layer stacked with a Cloudflare JS challenge: a plain fetch (crawler
 * UA, browser UA, and through the base fetch-proxy tier) returns HTTP 401 with a
 * `/__qrator/qauth.js` + `/cdn-cgi/challenge-platform` interstitial instead of
 * page content, and the proxy's heavier `render=1`/`solve=1`/`auto=1` tiers
 * timed out (502 / no response) on the runner. Until a render tier can clear the
 * challenge, the live leg yields nothing and the house is served by the Wikidata
 * backfill alone (QID Q138908 — see below). This adapter is written so it starts
 * producing the moment access returns, without code changes.
 *
 * Strategy, when reachable: the `/en/` season/repertoire index links each staged
 * work as a detail page. A modern CMS would emit schema.org Event JSON-LD
 * (preferred path — `extractEventJsonLd`); failing that we parse the page's
 * structured credit blocks. Composer comes from a "by {Composer}" / structured
 * author field (EN) or the Russian byline; performances from JSON-LD `subEvent`
 * dates or dated calendar rows. The deep past comes from Wikidata in `backfill`.
 */

const BASE = "https://www.bolshoi.ru";
const EN = `${BASE}/en`;
const VENUE = "Bolshoi Theatre";

/** Bolshoi Theatre on Wikidata — Q138908, "Bolshoi Theatre", description
 *  "historic theatre in Moscow, Russia" (P31 includes Q24354 theater; official
 *  website P856 = bolshoi.ru). Verified via wbsearchentities (the top "Bolshoi
 *  Theatre" hit) and the entity's P31/P856 claims. NOT Q2561905 (Bolshoi Theatre
 *  of Belarus), Q55657993 (the building record), or Q26790647 (the website
 *  entity). The prompt's suggested Q193835 is "Good Will Hunting" — wrong; ignore. */
const WIKIDATA_QID = "Q138908";

/** Whether to attempt the live `/en/` leg at all. The host is currently behind a
 *  Qrator + Cloudflare JS challenge that the available fetch tiers can't clear,
 *  so the live leg is best-effort: it tries, logs, and yields nothing today —
 *  Wikidata carries the house until access returns. */
const ATTEMPT_LIVE = true;

/** English creative-team labels → our canonical function slugs. */
const CREATIVE_FUNCTIONS_EN: Record<string, string> = {
  conductor: "conductor",
  "musical director": "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "production director": "director",
  "set designer": "set-designer",
  "stage designer": "set-designer",
  "scenery designer": "set-designer",
  "production designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  lighting: "lighting",
  "chorus master": "chorus-master",
  choreographer: "choreographer",
  dramaturg: "dramaturgy",
};

/** Russian creative-team labels → our canonical function slugs (fallback when the
 *  English mirror is missing a credit). Дирижёр=conductor, Режиссёр=director,
 *  Сценография/Художник=set-designer, Костюмы=costume-designer, Свет=lighting,
 *  Хормейстер=chorus-master. */
const CREATIVE_FUNCTIONS_RU: Record<string, string> = {
  дирижёр: "conductor",
  дирижер: "conductor",
  "музыкальный руководитель": "conductor",
  режиссёр: "director",
  режиссер: "director",
  "режиссёр-постановщик": "director",
  сценография: "set-designer",
  художник: "set-designer",
  "художник-постановщик": "set-designer",
  костюмы: "costume-designer",
  "художник по костюмам": "costume-designer",
  свет: "lighting",
  "художник по свету": "lighting",
  хормейстер: "chorus-master",
  "главный хормейстер": "chorus-master",
  хореограф: "choreographer",
};

export async function scrapeBolshoiTheatre(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  if (ATTEMPT_LIVE) {
    try {
      for (const url of await collectProductionUrls(ctx)) {
        try {
          const prod = parseProduction(await fetchProductionHtml(url, ctx), url, window);
          if (prod) productions.push(prod);
        } catch (err) {
          console.warn(`bolshoi-theatre: production ${url} failed:`, err);
        }
      }
    } catch (err) {
      console.warn("bolshoi-theatre: live scrape failed (expected — challenge wall):", err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("bolshoi-theatre: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "bolshoi-theatre", productions };
}

/** The challenge wall returns interstitial HTML on a plain fetch, so the live leg
 *  goes through a render (proxy-preferred via `fetchRendered`). A challenge page
 *  is treated as "no content" rather than parsed. */
async function fetchProductionHtml(url: string, ctx: FetchContext): Promise<string> {
  const html = await fetchRendered(url, ctx, { waitMs: 8000 });
  if (isChallengePage(html)) throw new Error("challenge wall (qrator/cloudflare)");
  return html;
}

function isChallengePage(html: string): boolean {
  return /__qrator|qauth\.js|cdn-cgi\/challenge-platform|__CF\$cv\$/i.test(html);
}

/** Collect `/en/` production detail URLs from the season/repertoire indexes. The
 *  exact path shape can't be confirmed while the site is walled, so we cast a
 *  wide net over the plausible English index pages and keep links that look like
 *  opera/performance detail pages. */
async function collectProductionUrls(ctx: FetchContext): Promise<string[]> {
  const indexes = [`${EN}/season/`, `${EN}/timetable/`, `${EN}/performances/`, `${EN}/repertoire/`];
  const urls = new Set<string>();
  for (const index of indexes) {
    try {
      const html = await fetchRendered(index, ctx, { waitMs: 8000 });
      if (isChallengePage(html)) continue;
      for (const [, href] of html.matchAll(/href="([^"#]+)"/g)) {
        if (href && DETAIL_RE.test(href)) urls.add(absolutize(href));
      }
    } catch (err) {
      console.warn(`bolshoi-theatre: index ${index} failed:`, err);
    }
  }
  return [...urls];
}

/** A detail URL under the English mirror: a performance/opera page with a numeric
 *  or slugged id segment (galas, news, and section landing pages are excluded by
 *  the keyword requirement). */
const DETAIL_RE = /\/en\/(?:performances|timetable|season|theatre)\/[^/]+\/[^/]+/i;

function absolutize(href: string): string {
  if (href.startsWith("http")) return href;
  return `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;
}

function parseProduction(html: string, url: string, window: ScrapeWindow): RawProduction | null {
  const ld = extractEventJsonLd(html)[0] as LdEvent | undefined;

  const composer = composerOf(html, ld);
  // No composer ⇒ ballet / concert / non-opera page. Opera gate.
  if (!composer) return null;

  const title = titleOf(html, ld);
  if (!title) return null;

  const performances = parsePerformances(html, ld, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html, ld);

  return {
    source_production_id: `bolshoi-theatre/${slugFromUrl(url)}`,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    image_url: imageOf(ld),
    creative_team,
    cast,
    performances,
  };
}

interface LdPerson {
  name?: string;
}
interface LdContributor {
  "@type"?: string;
  name?: string;
  roleName?: string;
  contributor?: LdPerson;
  performer?: LdPerson;
  characterName?: string;
}
interface LdSubEvent {
  startDate?: string;
  eventStatus?: string;
  location?: { name?: string };
}
interface LdEvent {
  name?: string;
  image?: string | { url?: string };
  inLanguage?: string;
  workPerformed?: {
    name?: string;
    author?: LdPerson | LdPerson[];
    creator?: LdPerson | LdPerson[];
  };
  performer?: LdContributor | LdContributor[];
  contributor?: LdContributor | LdContributor[];
  subEvent?: LdSubEvent | LdSubEvent[];
  startDate?: string;
}

/** Composer, in priority order: JSON-LD `workPerformed.author/creator`, then an
 *  English "by {Composer}" byline, then a Russian credit line. */
function composerOf(html: string, ld: LdEvent | undefined): string | null {
  const author = ld?.workPerformed?.author ?? ld?.workPerformed?.creator;
  const first = Array.isArray(author) ? author[0] : author;
  const ldName = stripHtml(first?.name ?? "");
  if (ldName) return ldName;

  const byline = stripHtml(html.match(/\bopera\b[^<]*?\bby\b\s+([^<,.()]{3,60})/i)?.[1] ?? "");
  if (byline) return byline;

  const ru = stripHtml(
    html.match(/(?:Музыка|Композитор)\s*[:\-—]?\s*([^<,.()]{3,60})/i)?.[1] ?? "",
  );
  return ru || null;
}

function titleOf(html: string, ld: LdEvent | undefined): string | null {
  const work = stripHtml(ld?.workPerformed?.name ?? "");
  if (work) return work;
  const ldName = stripHtml(ld?.name ?? "");
  if (ldName) return ldName;
  const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  return h1 || null;
}

function imageOf(ld: LdEvent | undefined): string | null {
  const img = ld?.image;
  if (typeof img === "string") return img;
  return img?.url ?? null;
}

function parseCredits(
  html: string,
  ld: LdEvent | undefined,
): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  const addCreative = (fn: string, name: string) => {
    const clean = stripHtml(name);
    if (!clean) return;
    const key = `${fn}|${clean}`;
    if (seenCreative.has(key)) return;
    seenCreative.add(key);
    creative_team.push({ function: fn, name: clean });
  };
  const addCast = (role: string, name: string) => {
    const r = stripHtml(role);
    const n = stripHtml(name);
    if (!r || !n) return;
    const key = `${r}|${n}`;
    if (seenCast.has(key)) return;
    seenCast.add(key);
    cast.push({ role: r, name: n });
  };

  const contributors = toArray(ld?.contributor);
  for (const c of contributors) {
    const fn = mapFunction(c.roleName ?? "");
    const name = c.contributor?.name ?? c.name ?? "";
    if (fn && name) addCreative(fn, name);
  }
  for (const p of toArray(ld?.performer)) {
    const name = p.performer?.name ?? p.name ?? "";
    if (p.characterName && name) addCast(p.characterName, name);
  }

  // HTML fallback for credits the JSON-LD omits: "Label: Name" rows (EN or RU).
  for (const [, label, name] of html.matchAll(
    /<[^>]*>\s*([A-Za-zА-Яа-яЁё][^<:]{2,40})\s*[:\-—]\s*<[^>]*>([^<]{2,60})</g,
  )) {
    const fn = mapFunction(label ?? "");
    if (fn && name) addCreative(fn, name);
  }

  return { creative_team, cast };
}

/** Map an English or Russian credit label to a canonical function slug. */
function mapFunction(label: string): string | null {
  const key = stripHtml(label).toLowerCase().replace(/\s+/g, " ").trim();
  return CREATIVE_FUNCTIONS_EN[key] ?? CREATIVE_FUNCTIONS_RU[key] ?? null;
}

/** Performances: JSON-LD `subEvent` nights when present, else dated rows scraped
 *  from the page. Honors window.since. */
function parsePerformances(
  html: string,
  ld: LdEvent | undefined,
  window: ScrapeWindow,
): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  const add = (date: IsoDate, time: string | null, status: RawPerformance["status"]) => {
    if (window.since && date < window.since) return;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ date, time, venue_room: VENUE, status });
  };

  const subs = toArray(ld?.subEvent);
  for (const sub of subs) {
    const m = (sub.startDate ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
    if (!m) continue;
    const date = m[1] as IsoDate;
    add(date, m[2] ?? null, statusOf(sub.eventStatus, date, today));
  }

  if (out.length === 0) {
    const start = (ld?.startDate ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
    if (start?.[1]) {
      const date = start[1] as IsoDate;
      add(date, start[2] ?? null, date < today ? "past" : "scheduled");
    }
  }

  if (out.length === 0) {
    for (const [, date] of html.matchAll(/datetime="(\d{4}-\d{2}-\d{2})/g)) {
      if (date) add(date as IsoDate, null, date < today ? "past" : "scheduled");
    }
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

function statusOf(status: unknown, date: IsoDate, today: string): RawPerformance["status"] {
  if (typeof status === "string" && /Cancelled/i.test(status)) return "cancelled";
  if (typeof status === "string" && /SoldOut/i.test(status)) return "sold_out";
  return date < today ? "past" : "scheduled";
}

function toArray<T>(value: T | T[] | undefined): T[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function slugFromUrl(url: string): string {
  return (
    url
      .replace(/^https?:\/\/[^/]+\//, "")
      .replace(/\/$/, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase() || url
  );
}
