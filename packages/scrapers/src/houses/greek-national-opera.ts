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
 * Greek National Opera (`spielplan-html`) — Athens, the national opera of Greece,
 * resident since 2017 at the Stavros Niarchos Hall (SNFCC). Joomla + K2pro CMS,
 * bilingual (EN pages served under `/en/`). Plain fetch (200 to the crawler UA,
 * no proxy), no schema.org Event JSON-LD:
 *   - Discovery: the "SN Opera" category page (`/en/stavros-niarchos-hall/sn-opera`)
 *     lists the mainstage opera programme as `…/item/{id}-{slug}` links — it carries
 *     the running season AND the announced next one (so recent past + full future),
 *     and is opera-only by construction (ballet/concerts live in sibling categories).
 *   - Detail page: `<h1>` work title; `<h2>Opera - {Composer}</h2>` subtitle gives
 *     the composer. The credit block at the foot of the K2 `itemFullText` is a
 *     paragraph of `{Label}: <strong>{Name}</strong>` pairs (Conductor, Stage
 *     direction…, Chorus master) followed by a `div.cf_parprotagon` cast list of
 *     `<p>{Role}<br><strong>{Name}</strong> (dates)…</p>` blocks (alternating casts
 *     printed inline; all names kept at production level).
 *   - Dates: the sidebar "Available Dates" prints day-runs anchored to a month —
 *     "18, 19, … 30 Jul 2026" (one or more "{days} {Mon} {YYYY}" groups, e.g.
 *     L'Orfeo straddles "30 Oct 2026 01, … 14 Nov 2026"). Start time from
 *     "Starts at: <strong>HH.MM</strong>". "Revival" badge → is_revival.
 *   - Opera gate: person-name composer AND (a cast list OR a director credit).
 */

const BASE = "https://www.nationalopera.gr";
const LISTING = `${BASE}/en/stavros-niarchos-hall/sn-opera`;

const EN_MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** English creative-function labels → canonical function slugs (substring-matched,
 *  first hit wins). Order matters: combined "Stage direction, sets, costumes,
 *  lighting" is primarily the director credit, so director precedes the designers;
 *  a bare "Lighting revival" (no "direction") still falls through to lighting. */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/conductor|musical direction/i, "conductor"],
  [/chorus master/i, "chorus-master"],
  [/choreograph/i, "choreographer"],
  [/stage direction|stage director|direction:/i, "director"],
  [/lighting/i, "lighting"],
  [/costume/i, "costume-designer"],
  [/set|scenograph/i, "set-designer"],
  [/dramaturg/i, "dramaturgy"],
];

export async function scrapeGreekNationalOpera(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let urls: string[];
  try {
    const listing = await fetchHtml(LISTING, ctx);
    urls = [
      ...new Set(
        [...listing.matchAll(/href="(\/en\/stavros-niarchos-hall\/sn-opera\/item\/[^"]+)"/g)].map(
          (m) => `${BASE}${m[1]}`,
        ),
      ),
    ];
  } catch (err) {
    console.warn("greek-national-opera: listing fetch failed:", err);
    return { house_slug: "greek-national-opera", productions };
  }

  for (const url of urls) {
    try {
      const html = await fetchHtml(url, ctx);
      const prod = parseProduction(html, url);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`greek-national-opera: ${url} failed:`, err);
    }
  }

  return { house_slug: "greek-national-opera", productions };
}

function parseProduction(html: string, url: string): RawProduction | null {
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const composer = stripHtml(
    html.match(/<h2[^>]*>\s*Opera\s*[-–]\s*([^<]+?)\s*<\/h2>/i)?.[1] ?? "",
  );
  if (!title || !isPersonName(composer)) return null;

  const { creative_team, cast } = parseCredits(html);
  // Opera gate: a real composer plus evidence this is a staged opera (cast or a
  // director credit) — drops anything miscategorised without a production team.
  const hasDirector = creative_team.some((c) => c.function === "director");
  if (cast.length === 0 && !hasDirector) return null;

  const performances = parsePerformances(html);
  const isRevival = /Available Dates[\s\S]{0,400}?\bRevival\b/i.test(html);
  const id = url.match(/\/item\/(\d+)-/)?.[1] ?? url;

  return {
    source_production_id: `greek-national-opera/${id}`,
    work_title: title,
    composer_name: composer,
    is_revival: isRevival || undefined,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: url,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** The K2 custom-field blocks: `div.cf_dimomada` (creative team) is a paragraph of
 *  `{Label}: <strong>{Name}<br></strong>` pairs (the `<br>` lives INSIDE the
 *  `<strong>`); `div.cf_parprotagon` (cast) comes in two layouts — role + names
 *  packed in one `<p>` ("<p>{Role}<br><strong>{Name}</strong>…</p>"), or role and
 *  names in separate sibling `<div>`s. Both are handled by tracking the current
 *  role across bare elements and attaching each `<strong>` name to it. */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const creativeBlock = sliceBlock(html, "cf_dimomada");
  const seenCrew = new Set<string>();
  for (const m of creativeBlock.matchAll(/([A-Za-z][A-Za-z ,/'’.-]{2,60}?):\s*<strong>\s*([^<]+)/g)) {
    const fn = CREATIVE_FUNCTIONS.find(([re]) => re.test(stripHtml(m[1] ?? "")))?.[1];
    if (!fn) continue;
    // A few labels list co-credits in one <strong> ("A, B"); split them out.
    for (const name of stripHtml(m[2] ?? "").split(/\s*,\s*|\s+&\s+/)) {
      const clean = name.replace(/[,;]+$/, "").trim();
      const key = `${fn}|${clean}`;
      if (isPersonName(clean) && !seenCrew.has(key)) {
        seenCrew.add(key);
        creative_team.push({ function: fn, name: clean });
      }
    }
  }

  // The cast list comes in three layouts (role above the names on its own line; role
  // and names in sibling <div>s; or "{Role}: <strong>{Name}</strong>" pairs inline).
  // A single pass over the <strong> names unifies them: each name takes the nearest
  // preceding role label, and a name with only a date qualifier before it inherits
  // the current role (alternating casts print each performer under one role).
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  const block = sliceBlock(html, "cf_parprotagon");
  let role = "";
  let cursor = 0;
  for (const nm of block.matchAll(/<strong>\s*([^<]+)/g)) {
    const label = roleFromGap(block.slice(cursor, nm.index));
    cursor = (nm.index ?? 0) + nm[0].length;
    if (label) role = label;
    const name = stripHtml(nm[1] ?? "").replace(/\s*\([^)]*\)\s*$/, "");
    // A role is a character name: it starts with a letter. Footnote/edition lines
    // ("* of the", "(revised by") and production-credit labels are not cast.
    if (!role || !/^\p{L}/u.test(role)) continue;
    if (/^(orchestra|chorus|ballet|with\b|featuring|dancers?\b|executive|producer|revised)/i.test(role))
      continue;
    if (/chorus|orchestra|ballet|ensemble|children/i.test(name)) continue;
    const key = `${role}|${name}`;
    if (isPersonName(name) && !seen.has(key)) {
      seen.add(key);
      cast.push({ role, name });
    }
  }
  return { creative_team, cast };
}

/** The role label preceding a cast name: the last meaningful segment of the gap
 *  between this `<strong>` and the previous one (split on line/element breaks),
 *  with date qualifiers and trailing colons stripped. Empty when the gap holds only
 *  a date — then the name inherits the running role (alternating cast). */
function roleFromGap(gap: string): string {
  const segments = gap.split(/<br\s*\/?>|<\/?(?:p|div)[^>]*>/i);
  for (let i = segments.length - 1; i >= 0; i--) {
    const cand = stripHtml(segments[i] ?? "")
      .replace(/\([^)]*\)/g, "")
      .replace(/[:\s]+$/, "")
      .trim();
    if (cand && !/^[\d,./&–-]+$/.test(cand)) return cand;
  }
  return "";
}

/** Content of a K2 custom-field `div.{cls}` up to the next custom-field block or the
 *  item links — bounds the regex scans so stray "{word}: <strong>" / sponsor names
 *  outside the credit blocks can't leak in. */
function sliceBlock(html: string, cls: string): string {
  const start = html.indexOf(`"${cls}"`);
  if (start < 0) return "";
  const rest = html.slice(start);
  const end = rest.slice(cls.length).search(/class="cf_|class="item/);
  return end < 0 ? rest : rest.slice(0, cls.length + end);
}

/** "Available Dates" sidebar: one or more "{day, day, …} {Mon} {YYYY}" groups,
 *  each day-run anchored to the trailing month/year. */
function parsePerformances(html: string): RawPerformance[] {
  const i = html.indexOf("Available Dates");
  if (i < 0) return [];
  const region = stripHtml(html.slice(i, i + 600));
  const time =
    html.match(/Starts at:(?:&nbsp;|\s)*<strong>\s*(\d{1,2})[.:](\d{2})/)?.slice(1).join(":") ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const g of region.matchAll(/(\d{1,2}(?:\s*,\s*\d{1,2})*)\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/g)) {
    const mo = EN_MONTHS[(g[2] ?? "").slice(0, 3).toLowerCase()];
    const year = Number.parseInt(g[3] ?? "", 10);
    if (!mo || !year) continue;
    for (const dayStr of (g[1] ?? "").split(",")) {
      const day = Number.parseInt(dayStr.trim(), 10);
      if (!day) continue;
      const date = iso(year, mo, day);
      if (seen.has(date)) continue;
      seen.add(date);
      out.push({ date, time, status: date < today ? "past" : "scheduled" });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function seasonOf(date: IsoDate | undefined): string | null {
  if (!date) return null;
  const [y, m] = date.split("-").map((n) => Number.parseInt(n, 10));
  if (!y || !m) return null;
  const start = m >= 8 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
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
