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
 * Sofia Opera and Ballet (`spielplan-html`) — the National Opera and Ballet, Sofia.
 * Bespoke CMS with a full English /en/ mirror, plain fetch (200 to the crawler UA,
 * no proxy), no schema.org Event JSON-LD:
 *   - Discovery: the opera-filtered repertoire (`/en/repertoire?category=opera`)
 *     lists every opera staging as `/en/repertoire/{id}` (the category filter keeps
 *     ballet/musical out).
 *   - Detail page: `<h1>` work title. Composer, cast AND creative team share ONE
 *     ordered list of `<span>{label}</span><h2><a href=".../staff/…">{Name}</a></h2>`
 *     pairs, in the sequence Composer → character roles → Conductor → production team.
 *     So the pairs are walked in order: "Composer" splits off; everything up to the
 *     first creative-function label is cast (character roles); from there the
 *     function-labelled pairs are the creative team (assistants / répétiteurs /
 *     stage managers skipped).
 *   - Performances: `<h2 class="title borders">{YYYY-MM-DD HH:MM}</h2>` date
 *     headings (each followed by a per-night cast widget that we ignore — the top
 *     list is the canonical cast).
 *   - Opera gate: a person-name composer AND (a cast list OR a director credit).
 */

const BASE = "https://www.operasofia.bg";

/** English creative-function labels → canonical function slugs (substring-matched). */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/conductor/i, "conductor"],
  [/chorus master|choir master/i, "chorus-master"],
  [/choreograph/i, "choreographer"],
  [/stage director|^director|direction/i, "director"],
  [/set design|scenograph/i, "set-designer"],
  [/costume/i, "costume-designer"],
  [/light/i, "lighting"],
  [/dramaturg/i, "dramaturg"],
];

/** Support roles that carry a creative-ish label but aren't production credits we keep. */
const SKIP_CREATIVE =
  /assistant|co-?repetiteur|r[ée]p[ée]titeur|consultant|preparation|stage manager|translat|laser/i;

export async function scrapeSofiaOpera(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let ids: string[];
  try {
    const index = await fetchHtml(`${BASE}/en/repertoire?category=opera`, ctx);
    ids = [
      ...new Set([...index.matchAll(/\/en\/repertoire\/(\d+)/g)].map((m) => m[1] ?? "")),
    ].filter(Boolean);
  } catch (err) {
    console.warn("sofia-opera: repertoire fetch failed:", err);
    return { house_slug: "sofia-opera", productions };
  }

  for (const id of ids) {
    try {
      const html = await fetchHtml(`${BASE}/en/repertoire/${id}`, ctx);
      const prod = parseProduction(html, id);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`sofia-opera: ${id} failed:`, err);
    }
  }

  return { house_slug: "sofia-opera", productions };
}

function parseProduction(html: string, id: string): RawProduction | null {
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const { composer, creative_team, cast } = parseCredits(html);
  if (!title || !isPersonName(composer)) return null;
  if (cast.length === 0 && !creative_team.some((c) => c.function === "director")) return null;

  return {
    source_production_id: `sofia-opera/${id}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/en/repertoire/${id}`,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances: parsePerformances(html),
  };
}

/** The single ordered credit list: Composer → character roles → creative team. */
function parseCredits(html: string): {
  composer: string;
  creative_team: RawCredit[];
  cast: RawCredit[];
} {
  let composer = "";
  let afterComposer = false;
  let inCreative = false;
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(
    /<span>([^<]+)<\/span>\s*<h2><a href="[^"]*\/staff\/[^"]*">([^<]+)<\/a><\/h2>/g,
  )) {
    const label = decodeEntities(stripHtml(m[1] ?? ""));
    const name = decodeEntities(stripHtml(m[2] ?? ""));
    if (!label || !name) continue;
    if (/^(composer|music)$/i.test(label)) {
      if (!composer) composer = name;
      afterComposer = true;
      continue;
    }
    if (/^(libretto|text|after |based on|world premiere|premiere)/i.test(label)) continue;

    const fn = CREATIVE_FUNCTIONS.find(([re]) => re.test(label))?.[1];
    if (fn) inCreative = true; // the production team begins at the first function label
    if (inCreative) {
      if (!fn || SKIP_CREATIVE.test(label)) continue;
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    } else if (
      afterComposer &&
      isPersonName(name) &&
      !SKIP_CREATIVE.test(label) &&
      !/director|design|conductor|subtitle|librettist|playwright|based on|adaptation/i.test(label)
    ) {
      // A few pages print a stray translation/director credit before the conductor;
      // a character role never carries those words, so it's safe to drop them here.
      const key = `${label}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role: label, name });
    }
  }
  return { composer, creative_team, cast };
}

/** `<h2 class="title borders">{YYYY-MM-DD HH:MM}</h2>` date headings. */
function parsePerformances(html: string): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/class="title borders">\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/g)) {
    const date = m[1] as IsoDate;
    const time = m[2] ?? null;
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
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
