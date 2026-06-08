import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Opéra de Lyon (`spielplan-html`) — the Lyon opera house. Nuxt (Vue) SSR site,
 * French. The genre is in the URL (`…/saison-{YYYY-YYYY}/opera/{slug}` vs
 * `/danse/`, `/concert/`), which IS the opera filter — dance and concerts never
 * enter. Plain fetch (200 to the crawler UA, no proxy):
 *   - Season pages `/programmation-reservations/saison-{YYYY-YYYY}` link the
 *     productions; only the `/opera/` ones are kept. Current + next season form
 *     the live leg (the site keeps no deep archive).
 *   - Detail page: `<h1>` work title; composer after "Un opéra de {X}"; the
 *     creative team AND cast are `<h2>{label}</h2>{name}` pairs — French function
 *     labels (Direction musicale→conductor, Mise en scène→director, Scénographie
 *     →set, Lumières→lighting, Costumes→costume, Chœur→chorus-master) map to the
 *     creative team, every other label is a cast character role (trailing
 *     `*`/`**`/`***` debut markers stripped).
 *   - The run's date RANGE is printed in the HTML; the individual nights (with
 *     times) live as ISO `startDate`s in the inline `window.__NUXT__` state, so
 *     performances = the state's `startDate`s that fall inside the run range.
 */

const BASE = "https://www.opera-lyon.com";

const FR_MONTHS: Record<string, number> = {
  janv: 1,
  févr: 2,
  fevr: 2,
  mars: 3,
  avr: 4,
  mai: 5,
  juin: 6,
  juil: 7,
  août: 8,
  aout: 8,
  sept: 9,
  oct: 10,
  nov: 11,
  déc: 12,
  dec: 12,
};

/** French creative-function labels → canonical function slugs (substring-matched;
 *  Lyon combines them, e.g. "Mise en scène et costumes"). First hit wins. */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/direction musicale|direction d'orchestre/i, "conductor"],
  [/mise en scène/i, "director"],
  [/chorégraph/i, "choreographer"],
  [/scénographie|décors?/i, "set-designer"],
  [/costumes?/i, "costume-designer"],
  [/lumières?|éclairage/i, "lighting"],
  [/chef de chœur|chœurs?|cheffe de chœur/i, "chorus-master"],
  [/dramaturg/i, "dramaturgy"],
];

export async function scrapeOperaDeLyon(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  // The fr sitemap enumerates every production URL; the `/opera/` genre segment is
  // the opera filter. Incremental keeps the current + next season; backfill walks
  // all the archived seasons the sitemap lists (back to 2023-24).
  let urls: { url: string; season: string; slug: string }[] = [];
  try {
    const sitemap = await fetchHtml(`${BASE}/sitemap/sitemap-fr.xml`, ctx);
    const recent = new Set(currentSeasonYears());
    for (const m of sitemap.matchAll(
      /https:\/\/www\.opera-lyon\.com\/fr\/programmation\/saison-(\d{4}-\d{4})\/opera\/([a-z0-9-]+)/g,
    )) {
      const season = m[1] as string;
      if (window.mode !== "backfill" && !recent.has(season)) continue;
      urls.push({ url: m[0], season, slug: m[2] as string });
    }
    urls = [...new Map(urls.map((u) => [`${u.season}/${u.slug}`, u])).values()];
  } catch (err) {
    console.warn("opera-de-lyon: sitemap fetch failed:", err);
    return { house_slug: "opera-de-lyon", productions };
  }

  for (const { url, season, slug } of urls) {
    try {
      const html = await fetchHtml(url, ctx);
      const prod = parseProduction(html, `${season}-${slug}`, url);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`opera-de-lyon: ${season}/${slug} failed:`, err);
    }
  }

  return { house_slug: "opera-de-lyon", productions };
}

/** The two seasons the site publishes — straddling the September boundary. */
function currentSeasonYears(): string[] {
  const now = new Date();
  const y = now.getFullYear();
  const startYear = now.getMonth() >= 7 ? y : y - 1; // Aug+ → new season
  return [`${startYear}-${startYear + 1}`, `${startYear + 1}-${startYear + 2}`];
}

function parseProduction(html: string, id: string, url: string): RawProduction | null {
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const composer = stripHtml(
    html.match(/Un opéra de\s*<\/h2>\s*<[^>]*>([\s\S]*?)<\//)?.[1] ??
      html.match(/Un opéra de\s+([^<]{2,40})/)?.[1] ??
      "",
  ).trim();
  if (!title || !composer) return null;

  const { creative_team, cast } = parseCredits(html);
  const performances = parsePerformances(html);
  if (performances.length === 0) return null;

  return {
    source_production_id: `opera-de-lyon/${id}`,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances,
  };
}

function ogImage(html: string): string | null {
  return (
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1] ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)?.[1] ??
    null
  );
}

/** `<h2>{label}</h2>{name}` pairs: French function labels → creative team, any
 *  other label → a cast character role (debut `*` markers stripped). */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const skip =
    /^(en quelques mots|présentation|distribution|vous aimerez aussi|soutenir|un opéra de|orchestre)/i;

  for (const m of html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>\s*<[^>]*>([\s\S]*?)<\//g)) {
    const label = stripHtml(m[1] ?? "");
    const name = stripHtml(m[2] ?? "")
      .replace(/\*+$/, "")
      .trim();
    if (!label || !name || skip.test(label) || name.length > 60) continue;
    const fn = CREATIVE_FUNCTIONS.find(([re]) => re.test(label))?.[1];
    if (fn) creative_team.push({ function: fn, name });
    else cast.push({ role: label, name });
  }
  return { creative_team, cast };
}

/** Individual nights: the inline `__NUXT__` ISO `startDate`s that fall inside the
 *  run range printed in the HTML ("4 oct. - 20 oct. 2026"). */
function parsePerformances(html: string): RawPerformance[] {
  const range = parseRange(html);
  if (!range) return [];
  const state = html.slice(html.indexOf("window.__NUXT__"));
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const m of state.matchAll(/startDate\s*:\s*"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/g)) {
    const date = m[1] as IsoDate;
    if (date < range.start || date > range.end) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, time: m[2] ?? null, status: date < today ? "past" : "scheduled" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** "4 oct. - 20 oct. 2026" / "14 déc. 2026 - 3 janv. 2027" / single "20 oct. 2026"
 *  → inclusive [start, end] ISO bounds. */
function parseRange(html: string): { start: IsoDate; end: IsoDate } | null {
  const text = decodeEntities(stripHtml(html));
  const m = text.match(
    /(\d{1,2})\s+([a-zà-ÿ]+)\.?\s*(20\d{2})?\s*[-–]\s*(\d{1,2})\s+([a-zà-ÿ]+)\.?\s+(20\d{2})/i,
  );
  if (m) {
    const endY = Number.parseInt(m[6] ?? "", 10);
    const endMo =
      FR_MONTHS[(m[5] ?? "").slice(0, 4).toLowerCase()] ??
      FR_MONTHS[(m[5] ?? "").slice(0, 3).toLowerCase()];
    const startMo =
      FR_MONTHS[(m[2] ?? "").slice(0, 4).toLowerCase()] ??
      FR_MONTHS[(m[2] ?? "").slice(0, 3).toLowerCase()];
    // A start year is given only when the range crosses a year boundary.
    const startY = m[3]
      ? Number.parseInt(m[3], 10)
      : endMo && startMo && startMo > endMo
        ? endY - 1
        : endY;
    if (startMo && endMo) {
      return {
        start: iso(startY, startMo, Number.parseInt(m[1] ?? "", 10)),
        end: iso(endY, endMo, Number.parseInt(m[4] ?? "", 10)),
      };
    }
  }
  const s = text.match(/(\d{1,2})\s+([a-zà-ÿ]+)\.?\s+(20\d{2})/i);
  if (s) {
    const mo =
      FR_MONTHS[(s[2] ?? "").slice(0, 4).toLowerCase()] ??
      FR_MONTHS[(s[2] ?? "").slice(0, 3).toLowerCase()];
    if (mo) {
      const d = iso(Number.parseInt(s[3] ?? "", 10), mo, Number.parseInt(s[1] ?? "", 10));
      return { start: d, end: d };
    }
  }
  return null;
}

function iso(y: number, m: number, d: number): IsoDate {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` as IsoDate;
}
