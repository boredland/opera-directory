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
 * Croatian National Theatre in Zagreb — Opera (`spielplan-html`) — Hrvatsko
 * narodno kazalište u Zagrebu (HNK), the opera division. Bespoke CMS with a full
 * English /en/ mirror, plain fetch (200 to the crawler UA, no proxy), no
 * schema.org Event JSON-LD:
 *   - Discovery: the opera index (`/en/opera/`) and the homepage calendar link
 *     stagings as `/en/opera/plays/{slug}/` — the `/opera/` genre segment IS the
 *     opera filter (drama/ballet/concert live under sibling segments).
 *   - Detail page: `<h1><span>{Composer}</span> {Title} <span>{duration}</span></h1>`.
 *     Creative team (`<h4>Creatives</h4>`) and cast (`<h4>Ensemble of the
 *     performance</h4>`) share one markup — `<p class="half">{label/role}</p><div
 *     class="half name"><span>{names}</span></div>` pairs — split by their heading;
 *     names are comma-separated (alternating casts), "(studijski)" understudy tags
 *     dropped, English creative labels mapped.
 *   - Performances: the dates are NOT on the detail page — they live only in the
 *     homepage calendar as anchors `/en/opera/plays/{slug}/#{DD}.{MM}.{HH}.{MM}`
 *     (a rolling ~2-month window, no year → inferred forward from today). Productions
 *     with no current calendar dates are still emitted (cast/creative only).
 *   - Opera gate: a person-name composer AND (a cast list OR a director credit) —
 *     drops the chamber/fellows concerts carried under /opera/.
 */

const BASE = "https://www.hnk.hr";

/** English creative-function labels → canonical function slugs (substring-matched). */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/conductor/i, "conductor"],
  [/chorus master|choir ?master/i, "chorus-master"],
  [/choreograph/i, "choreographer"],
  [/stage director|^director|direction/i, "director"],
  [/set design|scenograph/i, "set-designer"],
  [/costume/i, "costume-designer"],
  [/light/i, "lighting"],
  [/dramaturg/i, "dramaturg"],
];

export async function scrapeCntZagreb(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let slugs: string[];
  let dates: Map<string, RawPerformance[]>;
  try {
    const [home, index] = await Promise.all([
      fetchHtml(`${BASE}/en/`, ctx),
      fetchHtml(`${BASE}/en/opera/`, ctx),
    ]);
    dates = collectDates(home);
    slugs = [
      ...new Set(
        [...`${home}${index}`.matchAll(/\/en\/opera\/plays\/([^/"#]+)\//g)].map((m) => m[1] ?? ""),
      ),
    ].filter(Boolean);
  } catch (err) {
    console.warn("cnt-zagreb: discovery failed:", err);
    return { house_slug: "cnt-zagreb", productions };
  }

  for (const slug of slugs) {
    try {
      const html = await fetchHtml(`${BASE}/en/opera/plays/${slug}/`, ctx);
      const prod = parseProduction(html, slug, dates.get(slug) ?? []);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`cnt-zagreb: ${slug} failed:`, err);
    }
  }

  return { house_slug: "cnt-zagreb", productions };
}

/** Homepage calendar anchors `/en/opera/plays/{slug}/#{DD}.{MM}.{HH}.{MM}` → dated
 *  performances per slug. No year is printed; the calendar is a rolling forward
 *  window, so a month earlier than the current one rolls into next year. */
function collectDates(home: string): Map<string, RawPerformance[]> {
  const out = new Map<string, RawPerformance[]>();
  const now = new Date();
  const curMonth = now.getMonth() + 1;
  const today = now.toISOString().slice(0, 10);
  for (const m of home.matchAll(
    /\/en\/opera\/plays\/([^/"#]+)\/#(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})/g,
  )) {
    const slug = m[1] ?? "";
    const day = Number.parseInt(m[2] ?? "", 10);
    const month = Number.parseInt(m[3] ?? "", 10);
    const year = month >= curMonth ? now.getFullYear() : now.getFullYear() + 1;
    const date = iso(year, month, day);
    const time = `${m[4]}:${m[5]}`;
    const list = out.get(slug) ?? [];
    if (!list.some((p) => p.date === date && p.time === time)) {
      list.push({ date, time, status: date < today ? "past" : "scheduled" });
    }
    out.set(slug, list);
  }
  return out;
}

function parseProduction(
  html: string,
  slug: string,
  performances: RawPerformance[],
): RawProduction | null {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "";
  const composer = stripHtml(h1.match(/<span[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
  // Title is the h1 text node between the composer span and the trailing duration span.
  const title = stripHtml(h1.replace(/<span[^>]*>[\s\S]*?<\/span>/g, ""))
    .replace(/\s*\d+\s*min\.?$/i, "")
    .trim();
  if (!title || !isPersonName(composer)) return null;

  const creative_team = parsePairs(html, "Creatives", "creative");
  const cast = parsePairs(html, "Ensemble of the performance", "cast");
  if (cast.length === 0 && !creative_team.some((c) => c.function === "director")) return null;

  return {
    source_production_id: `cnt-zagreb/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/en/opera/plays/${slug}/`,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances: performances.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    ),
  };
}

/** `<h4>{heading}</h4>` … `<p class="half">{label}</p><div class="half name">
 *  <span>{names}</span></div>` pairs. Creative labels map to function slugs;
 *  for cast the label is the character role. Names are comma-separated with
 *  "(studijski)" understudy / parenthetical tags dropped. */
function parsePairs(html: string, heading: string, kind: "creative" | "cast"): RawCredit[] {
  const block =
    html.match(new RegExp(`${heading}</h4>([\\s\\S]*?)(?=<h4\\b|<h2\\b|</section)`))?.[1] ?? "";
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of block.matchAll(
    /<p class="half">([\s\S]*?)<\/p>\s*<div class="half name">\s*<span>([\s\S]*?)<\/span>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    if (!label) continue;
    const fn =
      kind === "creative" ? CREATIVE_FUNCTIONS.find(([re]) => re.test(label))?.[1] : undefined;
    if (kind === "creative" && (!fn || /assistant/i.test(label))) continue;
    if (kind === "cast" && /chorus|orchestra|ensemble|ballet/i.test(label)) continue;
    for (const part of stripHtml(m[2] ?? "").split(",")) {
      const name = part.replace(/\s*\([^)]*\)\s*/g, "").trim();
      if (!isPersonName(name)) continue;
      const key = `${fn ?? label}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(kind === "creative" ? { function: fn ?? null, name } : { role: label, name });
    }
  }
  return out;
}

// "pl." is the Croatian nobiliary particle (plemeniti), e.g. "Ivan pl. Zajc".
const NAME_PARTICLES = new Set([
  "von",
  "van",
  "de",
  "da",
  "di",
  "del",
  "der",
  "le",
  "la",
  "den",
  "pl",
]);

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
