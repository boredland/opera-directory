import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Lithuanian National Opera and Ballet Theatre (`spielplan-html`) — LNOBT, Vilnius.
 * Bespoke CMS (Koobin ticketing) with a full English /en/ mirror, plain fetch (200
 * to the crawler UA, no proxy), no schema.org Event JSON-LD:
 *   - Discovery: the homepage links the live repertoire as `/en/whatss-on/{slug}-e{id}`
 *     detail pages (sic — "whatss-on"; opera AND ballet mixed) → the genre is read
 *     off each page's header `div.duration` ("An opera in 2 acts…") and only opera
 *     is kept.
 *   - Detail page: `<h1>` work title. Creative team = `div.oe_team_list` of
 *     `<div class="team_item"><div class="role">{label}</div><div class="creators">
 *     {Name}</div></div>` rows — the composer is the "Composer" row; the rest map by
 *     English label. Cast = the per-performance `perf_item` cards (`<span>{Name}
 *     </span><span class="role">{Role}</span>`), aggregated across all nights and
 *     deduped (rows whose role is itself a creative function, e.g. Conductor, are
 *     dropped — they belong to the team).
 *   - Performances: the `oe_shows_list` — `year_title` / month `group_title`
 *     separators with `oe_show_item` rows (`day_side` + `time_side`); the weekday
 *     lives in the (misnamed) `month_side`.
 *   - Opera gate: header genre "opera" (not ballet) AND a person-name composer AND
 *     (a cast list OR a director credit).
 */

const BASE = "https://www.opera.lt";

const EN_MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** English creative-function labels → canonical function slugs (substring-matched,
 *  first hit wins). Composer/librettist and assistants are handled/skipped apart. */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/conductor|music director/i, "conductor"],
  [/chorus master|choir ?master/i, "chorus-master"],
  [/choreograph/i, "choreographer"],
  [/stage director|^director$|director$/i, "director"],
  [/set designer|scenograph/i, "set-designer"],
  [/costume/i, "costume-designer"],
  [/light/i, "lighting"],
  [/dramaturg/i, "dramaturgy"],
];

export async function scrapeLithuanianNationalOpera(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let urls: string[];
  try {
    const home = await fetchHtml(`${BASE}/en/`, ctx);
    urls = [
      ...new Set(
        [...home.matchAll(/\/en\/whatss-on\/[a-z0-9-]+-e\d+/g)].map((m) => `${BASE}${m[0]}`),
      ),
    ];
  } catch (err) {
    console.warn("lithuanian-national-opera: homepage fetch failed:", err);
    return { house_slug: "lithuanian-national-opera", productions };
  }

  for (const url of urls) {
    try {
      const html = await fetchHtml(url, ctx);
      const prod = parseProduction(html, url);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`lithuanian-national-opera: ${url} failed:`, err);
    }
  }

  return { house_slug: "lithuanian-national-opera", productions };
}

function parseProduction(html: string, url: string): RawProduction | null {
  const genre = stripHtml(html.match(/class="[^"]*\bduration\b[^"]*">\s*<div>([^<]+)/)?.[1] ?? "");
  if (!/\bopera\b/i.test(genre) || /\bballet\b/i.test(genre)) return null; // opera only

  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const { composer, creative_team } = parseTeam(html);
  if (!title || !isPersonName(composer)) return null;

  const cast = parseCast(html);
  if (cast.length === 0 && !creative_team.some((c) => c.function === "director")) return null;

  const id = url.match(/-e(\d+)$/)?.[1] ?? url;
  return {
    source_production_id: `lithuanian-national-opera/e${id}`,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances: parsePerformances(html),
  };
}

/** `div.oe_team_list` rows; the "Composer" row is split off, the rest mapped to a
 *  function (assistants / librettist dropped). `creators` may list co-credits. */
function parseTeam(html: string): { composer: string; creative_team: RawCredit[] } {
  const block = html.match(/oe_team_list[\s\S]*?(?=<\/div>\s*<\/div>\s*<\/div>|id="operaevents_)/)?.[0] ?? html;
  let composer = "";
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of block.matchAll(
    /class="role">([^<]+)<\/div>\s*<div class="creators">([\s\S]*?)<\/div>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    const names = stripHtml(m[2] ?? "")
      .split(/\s*,\s*|\s*&\s*|\s*\/\s*/)
      .map((n) => n.trim())
      .filter((n) => isPersonName(n));
    if (/^composer$/i.test(label)) {
      composer = names[0] ?? stripHtml(m[2] ?? "").trim();
      continue;
    }
    if (/assistant|librettist/i.test(label)) continue;
    const fn = CREATIVE_FUNCTIONS.find(([re]) => re.test(label))?.[1];
    if (!fn) continue;
    for (const name of names) {
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    }
  }
  return { composer, creative_team };
}

/** Per-performance `perf_item` cards aggregated across all nights: `<span>{Name}
 *  </span><span class="role">{Role}</span>`; rows whose role maps to a creative
 *  function (Conductor, …) belong to the team and are dropped. */
function parseCast(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<span>([^<]+)<\/span>\s*<span class="role">([^<]+)<\/span>/g,
  )) {
    const name = stripHtml(m[1] ?? "");
    const role = stripHtml(m[2] ?? "");
    if (!role || !/^\p{L}/u.test(role)) continue;
    if (CREATIVE_FUNCTIONS.some(([re]) => re.test(role)) || /chorus|orchestra|ensemble/i.test(role))
      continue;
    const key = `${role}|${name}`;
    if (isPersonName(name) && !seen.has(key)) {
      seen.add(key);
      out.push({ role, name });
    }
  }
  return out;
}

/** `oe_shows_list`: `year_title` / month `group_title` separators interleaved with
 *  `oe_show_item` rows (`day_side` + `time_side`), scanned in document order. */
function parsePerformances(html: string): RawPerformance[] {
  const list = html.match(/oe_shows_list[\s\S]*$/)?.[0] ?? html;
  const today = new Date().toISOString().slice(0, 10);
  let year = 0;
  let month = 0;
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of list.matchAll(
    /year_title">\s*(\d{4})|group_title">\s*([A-Za-z]+)|day_side">\s*(\d{1,2})\s*<[\s\S]*?time_side">\s*([\d:]+)/g,
  )) {
    if (m[1]) {
      year = Number.parseInt(m[1], 10);
    } else if (m[2]) {
      month = EN_MONTHS[m[2].toLowerCase()] ?? month;
    } else if (m[3] && year && month) {
      const date = iso(year, month, Number.parseInt(m[3], 10));
      const time = m[4] ?? null;
      const key = `${date}|${time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date, time, status: date < today ? "past" : "scheduled" });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}

const NAME_PARTICLES = new Set(["von", "van", "de", "da", "di", "del", "della", "der", "le", "la", "den"]);

function isPersonName(text: string): boolean {
  if (!text || /^\d/.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((w) => {
    const bare = w.replace(/[.'’-]/g, "");
    if (!bare) return true;
    if (NAME_PARTICLES.has(bare.toLowerCase())) return true;
    return /^\p{Lu}/u.test(bare);
  });
}

function ogImage(html: string): string | null {
  return (
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1] ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)?.[1] ??
    null
  );
}

function iso(y: number, m: number, d: number): IsoDate {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` as IsoDate;
}
