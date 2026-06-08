import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Opera Zuid (`json-api`) — the touring opera company of the southern Netherlands
 * (Maastricht). Headless WordPress behind a Next.js front end, Dutch:
 *   - The WP REST API exposes two custom post types. `agendaitem` is one row per
 *     dated performance, its title encoding "{Production} – YYYY-MM-DD HH:MM"; the
 *     dates are read from there (the production detail page only shows a run-range
 *     placeholder). `production` gives the slug + title for each show.
 *   - A production's detail page `/voorstelling/{slug}/` carries the composer
 *     (`.composer`) and the creative team + cast as
 *     `<div class="{role}">{Label} <span>{Name}</span></div>` blocks — Dutch
 *     function labels (Regie→director, Muzikale leiding→conductor, …) map to the
 *     creative team, every other label is a cast character role.
 *   - Performances are grouped to productions by a normalized title match (the
 *     agendaitem name drops the trailing "(8+)" / "(BOM …)" audience tags).
 *   - Opera gate: a person-name composer (drops the community/education items in
 *     the agenda that carry none).
 */

const BASE = "https://operazuid.nl";

/** Dutch creative-function labels → canonical function slugs. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  regie: "director",
  "muzikale leiding": "conductor",
  dirigent: "conductor",
  choreografie: "choreographer",
  decor: "set-designer",
  decorontwerp: "set-designer",
  "decor en kostuums": "set-designer",
  kostuums: "costume-designer",
  kostuumontwerp: "costume-designer",
  licht: "lighting",
  lichtontwerp: "lighting",
  koor: "chorus-master",
  koorleiding: "chorus-master",
  dramaturgie: "dramaturgy",
};

interface RestPost {
  slug: string;
  title: { rendered: string };
  link: string;
}

export async function scrapeOperaZuid(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let perfByProduction: Map<string, RawPerformance[]>;
  let catalogue: RestPost[];
  try {
    perfByProduction = await collectPerformances(ctx);
    catalogue = await fetchJson<RestPost[]>(
      `${BASE}/wp-json/wp/v2/production?per_page=100&_fields=slug,title,link`,
      ctx,
    );
  } catch (err) {
    console.warn("opera-zuid: REST discovery failed:", err);
    return { house_slug: "opera-zuid", productions };
  }

  for (const post of catalogue) {
    const performances = perfByProduction.get(normTitle(stripHtml(post.title.rendered)));
    if (!performances || performances.length === 0) continue; // no scheduled dates → skip
    try {
      const html = await fetchHtml(post.link, ctx);
      const prod = parseProduction(html, post, performances);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`opera-zuid: production ${post.slug} failed:`, err);
    }
  }

  return { house_slug: "opera-zuid", productions };
}

/** All `agendaitem` rows (paginated), parsed from their "{Production} – YYYY-MM-DD
 *  HH:MM" titles and grouped by normalized production title. */
async function collectPerformances(ctx: FetchContext): Promise<Map<string, RawPerformance[]>> {
  const byProduction = new Map<string, RawPerformance[]>();
  const today = new Date().toISOString().slice(0, 10);
  for (let page = 1; page <= 10; page++) {
    const rows = await fetchJson<{ title: { rendered: string } }[]>(
      `${BASE}/wp-json/wp/v2/agendaitem?per_page=100&page=${page}&_fields=title`,
      ctx,
    ).catch(() => []);
    if (rows.length === 0) break;
    for (const row of rows) {
      const m = stripHtml(row.title.rendered).match(
        /^(.*?)\s+[–-]\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/,
      );
      if (!m) continue;
      const date = m[2] as IsoDate;
      const key = normTitle(m[1] ?? "");
      const list = byProduction.get(key) ?? [];
      if (!list.some((p) => p.date === date && p.time === m[3])) {
        list.push({ date, time: m[3], status: date < today ? "past" : "scheduled" });
      }
      byProduction.set(key, list);
    }
    if (rows.length < 100) break;
  }
  return byProduction;
}

/** Normalize a title for the agenda↔production join: drop audience/series tags in
 *  parentheses ("Atman! (8+)" → "atman!"), lowercase, collapse whitespace. */
function normTitle(title: string): string {
  return decodeEntities(title)
    .replace(/\([^)]*\)/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseProduction(
  html: string,
  post: RestPost,
  performances: RawPerformance[],
): RawProduction | null {
  const composer = stripHtml(
    html.match(/class="[^"]*\bcomposer\b[^"]*"[^>]*>([\s\S]*?)<\//)?.[1] ?? "",
  );
  if (!isPersonName(composer)) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `opera-zuid/${post.slug}`,
    work_title: stripHtml(post.title.rendered),
    composer_name: composer,
    detail_url: post.link,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances: [...performances].sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    ),
  };
}

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
  "y",
  "den",
]);

function isPersonName(text: string): boolean {
  if (!text || /^\d/.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length < 1 || words.length > 5) return false;
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

/** `<div class="{role}">{Label} <span>{Name}</span></div>` credit blocks: Dutch
 *  function labels map to the creative team, every other label is a cast role. */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<div[^>]*class="[a-z0-9_-]+"[^>]*>\s*([^<>]+?)\s*<span>([^<]+)<\/span>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    const name = stripHtml(m[2] ?? "");
    if (!label || !name) continue;
    const key = `${label}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    if (fn) creative_team.push({ function: fn, name });
    else cast.push({ role: label, name });
  }
  return { creative_team, cast };
}
