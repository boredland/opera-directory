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
 * Slovak National Theatre — Opera (`spielplan-html`) — Opera SND, Bratislava (the
 * opera division of the Slovenské národné divadlo). Drupal site with an English
 * /en/ mirror. **`proxy: true`** — the host serves a broken TLS chain (missing
 * intermediate), so a direct fetch fails the cert; the proxy's base tier (TLS
 * verification off) gets the page:
 *   - Discovery: the opera repertoire index (`/en/repertoire-opera`) links every
 *     staging as `/en/inscenation/{id}/{slug}` — opera-only by division (no ballet),
 *     so the only filtering is dropping the pre-premiere matinées ("matiné k…", talks
 *     with no cast).
 *   - Detail page: `<h1>` / `<h2 class="title">` work title; `<h3 class="author">`
 *     composer ("Author: {X}"). Creative team + cast share one markup —
 *     `<div class="member"><span class="rola">{label/role}</span> … <span
 *     class="name">{Name}</span></div>` rows — split by their section ("Production
 *     Team" → creative, English labels mapped; "Cast" → character roles). Multiple
 *     `name` spans per row = co-credits / alternating singers.
 *   - Performances: the "Performance schedule" rows — `<span class="on-date">{D}. {M}.
 *     {YYYY}</span>` + `<span class="time-from">{HH:MM} h</span>`.
 *   - Opera gate: a person-name composer AND (a cast list OR a director credit).
 */

const BASE = "https://snd.sk";

/** English creative-function labels → canonical function slugs (substring-matched). */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/conductor/i, "conductor"],
  [/chorus master|choir ?master/i, "chorus-master"],
  [/choreograph/i, "choreographer"],
  [/stage director|^director|directed/i, "director"],
  [/stage design|set design|scenograph/i, "set-designer"],
  [/costume/i, "costume-designer"],
  [/light/i, "lighting"],
  [/dramaturg/i, "dramaturgy"],
];

export async function scrapeSlovakNationalTheatre(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let urls: string[];
  try {
    const index = await fetchHtml(`${BASE}/en/repertoire-opera`, ctx);
    urls = [
      ...new Set(
        [...index.matchAll(/\/en\/inscenation\/\d+\/[a-z0-9-]+/g)]
          .map((m) => m[0])
          .filter((u) => !/matine/i.test(u)) // pre-premiere talks, not stagings
          .map((u) => `${BASE}${u}`),
      ),
    ];
  } catch (err) {
    console.warn("slovak-national-theatre: repertoire fetch failed:", err);
    return { house_slug: "slovak-national-theatre", productions };
  }

  for (const url of urls) {
    try {
      const html = await fetchHtml(url, ctx);
      const prod = parseProduction(html, url);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`slovak-national-theatre: ${url} failed:`, err);
    }
  }

  return { house_slug: "slovak-national-theatre", productions };
}

function parseProduction(html: string, url: string): RawProduction | null {
  const title = stripHtml(
    html.match(/<h2 class="title"[^>]*>[\s\S]*?<span class="value">([\s\S]*?)<\/span>/)?.[1] ??
      html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ??
      "",
  );
  const composer = stripHtml(
    html.match(/class="author[^"]*">[\s\S]*?<span class="value">([\s\S]*?)<\/span>/)?.[1] ?? "",
  );
  if (!title || !isPersonName(composer)) return null;

  const creative_team = parseMembers(sectionAfter(html, "Production Team"), "creative");
  const cast = parseMembers(sectionAfter(html, "Cast"), "cast");
  if (cast.length === 0 && !creative_team.some((c) => c.function === "director")) return null;

  const id = url.match(/\/inscenation\/(\d+)\//)?.[1] ?? url;
  return {
    source_production_id: `slovak-national-theatre/${id}`,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances: parsePerformances(html),
  };
}

/** The markup between an `<h3>{heading}</h3>` and the next `<h3>`/`<h2>` (or the end
 *  — the cast section, which closes the content, has no trailing heading). */
function sectionAfter(html: string, heading: string): string {
  const re = new RegExp(`${heading}</h3>([\\s\\S]*?)(?=<h[23]\\b|$)`);
  return html.match(re)?.[1] ?? "";
}

/** `<div class="member"><span class="rola">{label}</span> … <span class="name">
 *  {Name}</span>…</div>` rows. For creative the label maps to a function slug
 *  (unmapped/assistant rows dropped); for cast the label is the character role. */
function parseMembers(section: string, kind: "creative" | "cast"): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of section.matchAll(/<div class="member">([\s\S]*?)<\/div>/g)) {
    const inner = m[1] ?? "";
    const label = stripHtml(inner.match(/class="rola">([^<]*)/)?.[1] ?? "");
    if (!label) continue;
    const fn =
      kind === "creative" ? CREATIVE_FUNCTIONS.find(([re]) => re.test(label))?.[1] : undefined;
    if (kind === "creative" && (!fn || /assistant/i.test(label))) continue;
    if (kind === "cast" && /chorus|orchestra|ensemble/i.test(label)) continue;
    for (const n of inner.matchAll(/class="name">([^<]+)/g)) {
      const name = stripHtml(n[1] ?? "");
      if (!isPersonName(name)) continue;
      const credit: RawCredit =
        kind === "creative" ? { function: fn ?? null, name } : { role: label, name };
      const key = `${fn ?? label}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(credit);
    }
  }
  return out;
}

/** "Performance schedule" rows: `<span class="on-date">{D}. {M}. {YYYY}</span>` +
 *  `<span class="time-from">{HH:MM} h</span>`. */
function parsePerformances(html: string): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /class="on-date">\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s*<\/span>[\s\S]{0,160}?class="time-from">\s*(\d{1,2}:\d{2})/g,
  )) {
    const date = iso(
      Number.parseInt(m[3] ?? "", 10),
      Number.parseInt(m[2] ?? "", 10),
      Number.parseInt(m[1] ?? "", 10),
    );
    const time = m[4] ?? null;
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

function iso(y: number, m: number, d: number): IsoDate {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` as IsoDate;
}
