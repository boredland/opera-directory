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
 * Latvian National Opera (`spielplan-html`) — Rīga, the national opera & ballet of
 * Latvia (LNOB). Bespoke CMS with a full English /en/ mirror, plain fetch (200 to
 * the crawler UA, no proxy), no schema.org Event JSON-LD:
 *   - Discovery: the repertoire index (`/en/repertoire/`) lists the live programme
 *     as `/en/production/{slug}/` links — opera AND ballet mixed, so the genre is
 *     read off each detail page (the banner `div.slider__top-left > h2`) and only
 *     "Opera" is kept.
 *   - Detail page: `<h1 class="open-show__title">` work title, `<h2
 *     class="open-show__sub-title">` composer. Creative team = `<a
 *     class="open-show__team">` cards (`.open-show__team__name` + English
 *     `.open-show__team__title` function). Cast = `<div id="nav-actors">` of
 *     `<p>{Role}: <a class="open-show__role">{Name}</a>, …</p>` rows (alternating
 *     casts comma-separated; all kept at production level).
 *   - Performances: the `ul.upcoming__items` slider — `<li><time>{weekday}
 *     <b>{month day}</b> <b>{HH:MM}</b></time>` — prints NO year, so the (ascending)
 *     month sequence is walked forward from today, rolling the year at each Jan wrap.
 *     This is the announced future only (a repertory house's upcoming dates).
 *   - Opera gate: banner genre "Opera" AND a person-name composer AND (a cast list
 *     OR a director credit).
 */

const BASE = "https://www.opera.lv";

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

/** English creative-function titles → canonical function slugs (substring-matched,
 *  first hit wins). Unknown titles (e.g. "Production of Video Art") are skipped. */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/conductor|music director/i, "conductor"],
  [/chorus master/i, "chorus-master"],
  [/choreograph/i, "choreographer"],
  [/stage director|director$/i, "director"],
  [/set designer/i, "set-designer"],
  [/costume/i, "costume-designer"],
  [/light/i, "lighting"],
  [/dramaturg/i, "dramaturgy"],
];

export async function scrapeLatvianNationalOpera(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let urls: string[];
  try {
    const index = await fetchHtml(`${BASE}/en/repertoire/`, ctx);
    urls = [
      ...new Set(
        [...index.matchAll(/href="(\/en\/production\/[^"]+)"/g)].map((m) => `${BASE}${m[1]}`),
      ),
    ];
  } catch (err) {
    console.warn("latvian-national-opera: repertoire fetch failed:", err);
    return { house_slug: "latvian-national-opera", productions };
  }

  for (const url of urls) {
    try {
      const html = await fetchHtml(url, ctx);
      const prod = parseProduction(html, url);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`latvian-national-opera: ${url} failed:`, err);
    }
  }

  return { house_slug: "latvian-national-opera", productions };
}

function parseProduction(html: string, url: string): RawProduction | null {
  const genre = stripHtml(
    html.match(/class="slider__top-left">\s*<h2>([^<]+)<\/h2>/)?.[1] ?? "",
  );
  if (!/opera/i.test(genre)) return null; // drops ballet

  const title = stripHtml(html.match(/class="open-show__title">([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const composer = stripHtml(
    html.match(/class="open-show__sub-title">([\s\S]*?)<\/h2>/)?.[1] ?? "",
  );
  if (!title || !isPersonName(composer)) return null;

  const creative_team = parseTeam(html);
  const cast = parseCast(html);
  if (cast.length === 0 && !creative_team.some((c) => c.function === "director")) return null;

  const slug = url.match(/\/production\/([^/]+)\//)?.[1] ?? url;
  return {
    source_production_id: `latvian-national-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances: parsePerformances(html),
  };
}

function parseTeam(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /class="open-show__team__name">([^<]+)<\/div>\s*<div class="open-show__team__title">([^<]+)</g,
  )) {
    const name = stripHtml(m[1] ?? "");
    const fn = CREATIVE_FUNCTIONS.find(([re]) => re.test(stripHtml(m[2] ?? "")))?.[1];
    if (!fn || !isPersonName(name)) continue;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ function: fn, name });
  }
  return out;
}

/** `<div id="nav-actors">` → `<p>{Role}: <a class="open-show__role">{Name}</a>, …</p>`
 *  rows; the role is the text before the colon, every linked artist a cast member. */
function parseCast(html: string): RawCredit[] {
  const block = html.match(/id="nav-actors">([\s\S]*?)<\/div>/)?.[1] ?? "";
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const p of block.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    const inner = p[1] ?? "";
    const role = stripHtml(inner.split(":")[0] ?? "");
    if (!role || /chorus|orchestra|ballet|ensemble/i.test(role)) continue;
    for (const a of inner.matchAll(/class="open-show__role[^"]*"[^>]*>([^<]+)<\/a>/g)) {
      const name = stripHtml(a[1] ?? "");
      const key = `${role}|${name}`;
      if (isPersonName(name) && !seen.has(key)) {
        seen.add(key);
        out.push({ role, name });
      }
    }
  }
  return out;
}

/** `ul.upcoming__items` slider, no years printed → walk the ascending month sequence
 *  forward from today, rolling the year whenever the month steps back (Jan wrap). */
function parsePerformances(html: string): RawPerformance[] {
  const block = html.match(/upcoming__items[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? "";
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let year = now.getFullYear();
  let prevMonth = now.getMonth() + 1;
  let first = true;
  const out: RawPerformance[] = [];

  for (const li of block.matchAll(/<time>([\s\S]*?)<\/time>/g)) {
    const text = stripHtml(li[1] ?? "");
    const m = text.match(/([a-z]+)\s+(\d{1,2})\b[\s\S]*?(\d{1,2}:\d{2})/i);
    if (!m) continue;
    const month = EN_MONTHS[(m[1] ?? "").toLowerCase()];
    if (!month) continue;
    if (first) {
      if (month < prevMonth) year++;
      first = false;
    } else if (month < prevMonth) {
      year++;
    }
    prevMonth = month;
    const date = iso(year, month, Number.parseInt(m[2] ?? "", 10));
    out.push({ date, time: m[3] ?? null, status: date < today ? "past" : "scheduled" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}

const NAME_PARTICLES = new Set(["von", "van", "de", "da", "di", "del", "der", "le", "la", "den"]);

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
