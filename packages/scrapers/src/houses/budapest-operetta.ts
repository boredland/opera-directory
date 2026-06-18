import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";

/**
 * Budapest Operetta Theatre / Budapesti Operettszínház (`spielplan-html`) —
 * Hungary's flagship operetta and musical-theatre house. Repertory company:
 * several titles run in parallel each season, sung in Hungarian.
 *
 * Custom CMS, Hungarian, plain fetch (200 to the crawler UA, no proxy), no
 * schema.org Event JSON-LD. Productions live at `/repertoar/{slug}`; each dated
 * performance is its own page `/repertoar/{slug}-eid{N}` carrying the full
 * production metadata PLUS that night's date — so the whole scrape runs off the
 * per-performance pages (the base page's date calendar is JS-rendered and empty
 * in the HTML):
 *   - Discovery: `/musor` (the schedule) lists every upcoming `-eid{N}` link.
 *     Grouping them by base slug (strip `-eid{N}`) yields the productions; the
 *     announced future is the live leg (no separate deep archive).
 *   - Each `-eid` page: `<h1 class="…anim…">` work title, `<h2 class="…anim…">`
 *     composer, the night's date as Hungarian text ("2026. június 09. kedd,
 *     19:00") and a premiere line ("Bemutató: 2025. nov. 21.").
 *   - Cast + creative are `<a href="…/tarsulat/…">Name<span>role/label</span></a>`
 *     pairs, split by section: between the `Szereposztás` (cast) and `Alkotók`
 *     (creators) headings they are cast roles; after `Alkotók` they are crew,
 *     mapped from Hungarian function labels (Rendező→director, Karmester/Zenei
 *     vezető→conductor, Koreográfus→choreographer, Díszlet/Jelmez/Világítás…),
 *     unmapped crew dropped.
 *   - Opera/operetta gate: a person-name composer + a cast list, and the title is
 *     not a gala/circus evening — drops the variety galas and crossover shows
 *     that share the schedule, keeping the staged operettas and book musicals.
 */

const BASE = "https://operett.hu";
const MUSOR = `${BASE}/musor`;

/** Hungarian month names (full + the abbreviations used in premiere lines). */
const HU_MONTHS: Record<string, number> = {
  január: 1,
  jan: 1,
  február: 2,
  febr: 2,
  március: 3,
  márc: 3,
  április: 4,
  ápr: 4,
  május: 5,
  máj: 5,
  június: 6,
  jún: 6,
  július: 7,
  júl: 7,
  augusztus: 8,
  aug: 8,
  szeptember: 9,
  szept: 9,
  október: 10,
  okt: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/** Hungarian creative-function labels → our canonical function slugs. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  rendező: "director",
  rendezte: "director",
  karmester: "conductor",
  "zenei vezető": "conductor",
  vezényel: "conductor",
  "zenei igazgató": "conductor",
  koreográfus: "choreographer",
  koreográfia: "choreographer",
  díszlettervező: "set-designer",
  díszlet: "set-designer",
  jelmeztervező: "costume-designer",
  jelmez: "costume-designer",
  világítástervező: "lighting",
  karigazgató: "chorus-master",
  dramaturg: "dramaturgy",
};

const NON_OPERA_TITLE = /\bgála|gala|cirkusz|koncert|gálaest|gálaeste\b/i;

export async function scrapeBudapestOperetta(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const byProduction = new Map<string, RawProduction>();

  let eidSlugs: string[] = [];
  try {
    const musor = await fetchHtml(MUSOR, ctx);
    eidSlugs = [
      ...new Set(
        [...musor.matchAll(/\/repertoar\/([a-z0-9-]+-eid\d+)/g)].map((m) => m[1] as string),
      ),
    ];
  } catch (err) {
    console.warn("budapest-operetta: schedule fetch failed:", err);
    return { house_slug: "budapest-operetta", productions: [] };
  }

  for (const eid of eidSlugs) {
    try {
      const html = await fetchHtml(`${BASE}/repertoar/${eid}`, ctx);
      addPerformance(byProduction, html, eid);
    } catch (err) {
      console.warn(`budapest-operetta: performance ${eid} failed:`, err);
    }
  }

  return { house_slug: "budapest-operetta", productions: [...byProduction.values()] };
}

/** Parse one `-eid` performance page and merge it into its production (keyed by
 *  the base slug), appending the night and seeding metadata on first sight. */
function addPerformance(byProduction: Map<string, RawProduction>, html: string, eid: string): void {
  const base = eid.replace(/-eid\d+$/, "");
  const title = stripHtml(
    html.match(/<h1[^>]*class="[^"]*anim[^"]*"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "",
  );
  if (!title || NON_OPERA_TITLE.test(title)) return;

  const composer = composerFrom(html);
  if (!composer) return;

  const performance = parsePerformanceDate(html);
  if (!performance) return;

  let prod = byProduction.get(base);
  if (!prod) {
    const { cast, creative_team } = parseCredits(html);
    if (cast.length === 0) return; // a gala / non-staged evening
    prod = {
      source_production_id: `budapest-operetta/${base}`,
      work_title: title,
      composer_name: composer,
      premiere_date: parsePremiere(html),
      language: "hu",
      detail_url: `${BASE}/repertoar/${base}`,
      image_url: ogImage(html),
      creative_team,
      cast,
      performances: [],
    };
    byProduction.set(base, prod);
  }
  if (!prod.performances.some((p) => p.date === performance.date && p.time === performance.time)) {
    prod.performances.push(performance);
  }
}

/** Composer = the `<h2 class="anim">` byline (first name of a "X - Y" / "X és Y"
 *  composer-lyricist credit), or, when the page prints no composer heading (some
 *  musicals), the name carrying the "Zene" / "Zeneszerző" (music) credit pair. */
function composerFrom(html: string): string | null {
  const heading = stripHtml(
    html.match(/<h2[^>]*class="[^"]*anim[^"]*"[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "",
  );
  const first = heading.split(/\s[-–]\s|\/|&| és /i)[0]?.trim();
  if (first && personName(first)) return first;

  for (const m of html.matchAll(
    /<a\s+href="[^"]*\/tarsulat\/[^"]*"[^>]*>([^<]+)<span[^>]*>([^<]+)<\/span>/g,
  )) {
    // "Zene" / "Zeneszerző" / "Zeneszerző, dalszövegíró" — but NOT "Zenei vezető"
    // (conductor). A trailing space/comma/end fences it off; \b can't, since the
    // non-ASCII "ő" defeats the word boundary.
    if (/^zene(szerző)?(?:[\s,]|$)/i.test(decodeEntities(m[2] ?? "").trim())) {
      const name = decodeEntities(m[1] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (personName(name)) return name;
    }
  }
  return null;
}

const NAME_PARTICLES = new Set(["von", "van", "de", "da", "di", "del", "der", "le", "la", "y"]);

function personName(text: string): string | null {
  if (!text || /^\d/.test(text)) return null;
  const words = text.split(/\s+/);
  if (words.length < 1 || words.length > 5) return null;
  const ok = words.every((w) => {
    const bare = w.replace(/[.'’-]/g, "");
    if (!bare) return true;
    if (NAME_PARTICLES.has(bare.toLowerCase())) return true;
    return /^\p{Lu}/u.test(bare);
  });
  return ok ? text : null;
}

function ogImage(html: string): string | null {
  return (
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1] ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)?.[1] ??
    null
  );
}

/** "2026. június 09. kedd, 19:00" → { date, time, venue_room }. */
function parsePerformanceDate(html: string): RawPerformance | null {
  const text = stripHtml(html);
  const m = text.match(
    /(\d{4})\.\s*([a-záéíóöőúüű]+)\s*(\d{1,2})\.\s*[a-záéíóöőúüű]*,?\s*(\d{1,2}):(\d{2})/i,
  );
  if (!m) return null;
  const month = HU_MONTHS[(m[2] ?? "").toLowerCase()];
  const day = Number.parseInt(m[3] ?? "", 10);
  if (!month || day < 1 || day > 31) return null;
  const year = Number.parseInt(m[1] ?? "", 10);
  const date = isoFromParts(year, month, day);
  if (!date) return null;
  const venue_room =
    text.match(/\b(Nagyszínpad|Kálmán Imre Teátrum|Raktárszínház|Óriáspódium)\b/)?.[1] ?? null;
  const status: RawPerformance["status"] =
    date < new Date().toISOString().slice(0, 10) ? "past" : "scheduled";
  return { date, time: `${(m[4] ?? "").padStart(2, "0")}:${m[5]}`, venue_room, status };
}

/** "Bemutató: 2025. nov. 21." → "2025-11-21". */
function parsePremiere(html: string): IsoDate | null {
  const m = stripHtml(html).match(/Bemutató:\s*(\d{4})\.\s*([a-záéíóöőúüű]+)\.?\s*(\d{1,2})/i);
  if (!m) return null;
  const month = HU_MONTHS[(m[2] ?? "").toLowerCase()];
  const day = Number.parseInt(m[3] ?? "", 10);
  if (!month || !day) return null;
  return isoFromParts(m[1] ?? "", month, day);
}

/** Cast + creative from the `<a href="…/tarsulat/…">Name<span>label</span></a>`
 *  pairs: those before the `Alkotók` (creators) heading are cast roles, those
 *  after are crew mapped from the Hungarian function map (unmapped crew dropped). */
function parseCredits(html: string): { cast: RawCredit[]; creative_team: RawCredit[] } {
  const castStart = html.indexOf("Szereposztás");
  const creativeStart = html.indexOf("Alkotók");
  const cast: RawCredit[] = [];
  const creative_team: RawCredit[] = [];
  if (castStart < 0) return { cast, creative_team };

  const re = /<a\s+href="[^"]*\/tarsulat\/[^"]*"[^>]*>([^<]+)<span[^>]*>([^<]+)<\/span>/g;
  const region = html.slice(castStart);
  const splitAt = creativeStart > castStart ? creativeStart - castStart : region.length;
  for (const m of region.matchAll(re)) {
    const name = decodeEntities(m[1] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const label = decodeEntities(m[2] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!name || !label) continue;
    if ((m.index ?? 0) < splitAt) {
      cast.push({ role: label, name });
    } else {
      const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
      if (fn) creative_team.push({ function: fn, name });
    }
  }
  return { cast, creative_team };
}
