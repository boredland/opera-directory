import type { IsoDate, LangCode } from "@opera-directory/schema";
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
 * Northern Ireland Opera (`spielplan-html`) — Belfast-based national company for
 * NI (founded 2010), staging a few mainstage operas a year alongside a heavy
 * programme of recitals, cabarets, concerts and Christmas events (all dropped).
 *
 * WordPress (Bedrock), English, plain fetch (200 to the crawler UA, no proxy);
 * only Yoast WebPage/Organization JSON-LD, so everything is parsed from SSR HTML:
 *   - The homepage links upcoming detail pages `/performances/{slug}/`; the
 *     bounded `/past-productions/` page lists the full history under the same path
 *     (collected only in backfill mode).
 *   - Detail page header: `<h1 class="date">` (the performance dates for the
 *     future, OR a season label like "2016/17 SEASON" for archive items),
 *     `<h2 class="title">` = work title, `<p class="excerpt">` = composer (English
 *     byline; co-credits split on &/and/slash, composer first).
 *   - Cast + Creative Team share one `<div class="credits-section--the-team">`:
 *     an `<h4 class="title">Cast</h4>` / `Creative Team` sub-header followed by
 *     `<h5 class="title">{role|label}</h5><h6 class="name">{name}</h6>` pairs.
 *     English creative labels are mapped in-adapter.
 *   - Opera filter: a person-name composer that is NOT a series/category label
 *     (NON_COMPOSER) AND a stage Director credit — drops the recitals, cabarets,
 *     song programmes, concerts, Christmas shows and "in conversation" talks
 *     (which lack a Director and/or label the composer slot "Various" / "Irish Art
 *     Song" / "A Salon Series Event" / the company name).
 *   - The archive prints only a SEASON (no dates), so those productions are
 *     emitted with `premiere_season` and no performances (still contributing the
 *     work/cast/creative graph) — the same shape the Wikidata backfill uses.
 */

const BASE = "https://niopera.com";
const ARCHIVE = `${BASE}/past-productions/`;
const DETAIL = `${BASE}/performances`;

const MONTHS: Record<string, number> = {
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

/** English creative-team labels → our canonical function slugs. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "musical director": "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  designer: "set-designer",
  "set designer": "set-designer",
  "set & costume designer": "set-designer",
  "set and costume designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "lighting design": "lighting",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

const SUNG_LANGUAGES: Record<string, LangCode> = {
  french: "fr",
  italian: "it",
  german: "de",
  english: "en",
  russian: "ru",
  czech: "cs",
};

/** Category / event words that show up in NI's composer byline slot for
 *  non-operas (series labels, concert/recital programmes, the company name).
 *  No real composer name contains any of these. */
const NON_COMPOSER =
  /\b(various|music|opera|salon|series|concert|recital|songs?|carols?|outreach|conversation|competition|event|anthem|melodies|scenes|lovers|christmas|festival|gala|cabaret|film)\b/i;

/** NI's recurring touring/resident venues, matched from the prose blurb. */
const VENUES =
  /(Grand Opera House|Lyric Theatre|Ulster Hall|The MAC|Theatre at the Mill|Carlisle Memorial|Millennium Forum|Strule Arts Centre|Market Place Theatre|Belfast)/;

export async function scrapeNorthernIrelandOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const slugs = await collectSlugs(ctx, window.mode === "backfill");
    for (const slug of slugs) {
      try {
        const html = await fetchHtml(`${DETAIL}/${slug}/`, ctx);
        const prod = parseEvent(html, slug);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`northern-ireland-opera: event ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("northern-ireland-opera: live scrape failed:", err);
  }

  return { house_slug: "northern-ireland-opera", productions };
}

/** Detail slugs from the homepage (upcoming) plus the bounded past-productions
 *  archive in backfill mode. */
async function collectSlugs(ctx: FetchContext, includeArchive: boolean): Promise<string[]> {
  const slugs = new Set<string>();
  const pages = includeArchive ? [`${BASE}/`, ARCHIVE] : [`${BASE}/`];
  for (const page of pages) {
    const html = await fetchHtml(page, ctx);
    for (const [, slug] of html.matchAll(/\/performances\/([^"'?#/\s]+)\//g)) {
      if (slug && slug !== "calendar-of-events") slugs.add(decodeURIComponent(slug));
    }
  }
  return [...slugs];
}

function parseEvent(html: string, slug: string): RawProduction | null {
  const title = stripHtml(
    html.match(/<h2[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "",
  ).trim();
  const composer = personName(
    stripHtml(html.match(/class="[^"]*\bexcerpt\b[^"]*"[^>]*>([\s\S]*?)<\//)?.[1] ?? ""),
  );
  if (!title || !composer || NON_COMPOSER.test(composer)) return null;

  const { creative_team, cast } = parseCredits(html);
  // Opera gate: a staged work has a stage Director. Recitals, cabarets, song
  // programmes, concerts and talks don't — they either lack a Director credit or
  // put a series/category label ("Various", "Irish Art Song", "A Salon Series
  // Event", even the company name) in the composer slot, caught by NON_COMPOSER.
  if (!creative_team.some((c) => c.function === "director")) return null;

  const dateField = stripHtml(
    html.match(/<h1[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "",
  );
  const { performances, season } = parseDateField(dateField, html);
  if (performances.length === 0 && !season) return null;

  return {
    source_production_id: `northern-ireland-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    premiere_season: season,
    detail_url: `${DETAIL}/${slug}/`,
    image_url: ogImage(html),
    language: sungLanguage(html),
    creative_team,
    cast,
    performances,
  };
}

const NAME_PARTICLES = new Set(["von", "van", "de", "da", "di", "del", "der", "le", "la", "y"]);

/** Validate + normalize an English byline to a single composer name (first of any
 *  composer/librettist co-credit). Rejects taglines that aren't a person name. */
function personName(text: string): string | null {
  const first = text.split(/\s*(?:&|\/| and )\s*/i)[0]?.trim();
  if (!first || /^\d/.test(first)) return null;
  const words = first.split(/\s+/);
  if (words.length < 1 || words.length > 5) return null;
  const ok = words.every((w) => {
    const bare = w.replace(/[.'’-]/g, "");
    if (!bare) return true;
    if (NAME_PARTICLES.has(bare.toLowerCase())) return true;
    return /^\p{Lu}/u.test(bare);
  });
  return ok ? first : null;
}

function ogImage(html: string): string | null {
  return (
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1] ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)?.[1] ??
    null
  );
}

function sungLanguage(html: string): LangCode | null {
  const m = stripHtml(html).match(/sung in ([A-Za-z]+)/i);
  return m ? (SUNG_LANGUAGES[(m[1] ?? "").toLowerCase()] ?? null) : null;
}

/** Cast + Creative from the single `--the-team` block: an `<h4>` sub-header
 *  ("Cast" / "Creative Team") followed by `<h5>{role|label}</h5><h6>{name}</h6>`
 *  pairs. The `<h4>` boundaries decide whether a pair is a cast role or a credit. */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const block =
    html.match(/credits-section--the-team[\s\S]*?(?=<\/section|<footer|More Shows)/)?.[0] ?? "";
  const cast: RawCredit[] = [];
  const creative_team: RawCredit[] = [];

  let mode: "cast" | "creative" | null = null;
  const tokens = block.matchAll(
    /<h4[^>]*>([\s\S]*?)<\/h4>|<h5[^>]*>([\s\S]*?)<\/h5>\s*<h6[^>]*>([\s\S]*?)<\/h6>/g,
  );
  for (const t of tokens) {
    if (t[1] !== undefined) {
      const h = stripHtml(t[1]).toLowerCase();
      mode = h.includes("cast")
        ? "cast"
        : h.includes("creative") || h.includes("team")
          ? "creative"
          : mode;
      continue;
    }
    const label = stripHtml(t[2] ?? "");
    const name = stripHtml(t[3] ?? "");
    if (!isRealName(name)) continue;
    if (mode === "cast") {
      cast.push({ role: label, name });
    } else if (mode === "creative") {
      const fn = CREATIVE_FUNCTIONS[label.toLowerCase().trim()];
      if (fn) creative_team.push({ function: fn, name });
    }
  }
  return { creative_team, cast };
}

function isRealName(name: string): boolean {
  return Boolean(name) && !/^(tbc|tba)$/i.test(name.trim());
}

/** The `<h1 class="date">` is either explicit performance dates ("12, 15, 17, 19
 *  September 2026" / "12–19 September 2026") or a season label ("2016/17 SEASON").
 *  Returns dated performances for the former, a `premiere_season` for the latter. */
function parseDateField(
  text: string,
  html: string,
): { performances: RawPerformance[]; season: string | null } {
  const decoded = decodeEntities(text);
  const my = decoded.match(/([A-Za-z]+)\s+(20\d{2})/);
  const month = my ? MONTHS[(my[1] ?? "").toLowerCase()] : undefined;
  if (!month || !my) {
    const season = decoded.replace(/season/i, "").trim() || null;
    return { performances: [], season };
  }
  const year = Number.parseInt(my[2] ?? "", 10);
  // Day numbers printed before the month (a comma list or a dash range).
  const days = [...decoded.slice(0, my.index).matchAll(/\b(\d{1,2})\b/g)].map((m) =>
    Number.parseInt(m[1] ?? "", 10),
  );
  const uniqueDays = [...new Set(days.filter((d) => d >= 1 && d <= 31))];
  const time = parseTime(stripHtml(html));
  const venue_room = html.match(VENUES)?.[1] ?? null;

  const performances = uniqueDays.flatMap((day) => {
    const date = isoFromParts(year, month, day);
    if (!date) return [];
    return [{ date, time, venue_room, status: nightStatus(date) }];
  });
  return { performances, season: null };
}

/** First clock time on the page ("7.30pm" → "19:30"); NI prints a single show time. */
function parseTime(text: string): string | null {
  const m = text.match(/\b(\d{1,2})[.:](\d{2})\s*([ap]m)\b/i);
  if (!m) return null;
  let hour = Number.parseInt(m[1] ?? "", 10);
  if (Number.isNaN(hour)) return null;
  const isPm = (m[3] ?? "").toLowerCase() === "pm";
  if (isPm && hour < 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

function nightStatus(date: IsoDate): RawPerformance["status"] {
  return date < new Date().toISOString().slice(0, 10) ? "past" : "scheduled";
}
