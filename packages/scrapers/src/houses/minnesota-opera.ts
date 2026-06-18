import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";

/**
 * Minnesota Opera (`spielplan-html` strategy) — a year-round US opera company in
 * St. Paul, Minnesota (season ~Sep–May at the Ordway Center). The live scrape
 * reads the announced + recent seasons off the marketing site; `backfill` walks
 * the deep season archive and appends Wikidata for the long historical tail.
 *
 * WordPress on WP Engine. Every season page, production page and production
 * subpage (synopsis, cast list, blog posts) is one `op_shows` custom post,
 * exposed at `/wp-json/wp/v2/op_shows`. There is no Event JSON-LD and no ACF in
 * the REST payload, so production data is parsed out of the production page HTML;
 * the REST list is used only to enumerate candidate pages (id, slug, link).
 *
 * A production page lives at `/season/{season}/{slug}/` (one segment under the
 * season); subpages nest one level deeper and are skipped. The real opera gate is
 * a parsed composer + at least one dated performance — that alone drops the
 * galas, parties, subscription/renew pages, the MNOP+ concert series and the
 * archived COVID-season stubs, none of which print a structured composer.
 *
 * Two page templates exist; the parser handles both:
 *   - current (2025/26+): performances as `<p class="p1">Saturday, May 9 at
 *     7:30pm<br/>…</p>` (individual nights) and the composer on a `MUSIC BY` /
 *     `MUSIC AND LIBRETTO BY {NAME}` line (ENGLISH structured field — NOT German
 *     composerFromText).
 *   - older: a single `<h2 class="sub-title">May 7–22, 2022</h2>` run range and a
 *     `<h4>Music by {NAME}…</h4>` composer; the range's start date is emitted as
 *     one performance (the page lists no individual nights once tickets close —
 *     Wikidata supplies the deep past).
 *
 * Cast + creative team live on the `/cast-and-creative-team/` subpage as
 * `biolist` cards (`<a>Name</a><br/>Role`), split by `Cast` / `Creative Team`
 * headings. Creative function labels are ENGLISH and mapped in-adapter
 * (CREATIVE_FUNCTIONS); cast roles are kept verbatim for the resolver.
 */

const BASE = "https://mnopera.org";
const VENUE = "Ordway Center for the Performing Arts";

/** Minnesota Opera on Wikidata — the opera COMPANY (Q6868391, "opera company
 *  based in Minneapolis, Minnesota, USA"), not a venue. Verified via
 *  wbsearchentities on "Minnesota Opera" — Q6868391 is the sole company match
 *  (the only other hit is an unrelated 1997 flood-response article). */
const WIKIDATA_QID = "Q6868391";

/** English creative labels → our canonical function slugs. Original/revival/
 *  associate/assistant variants fold onto the principal function; unmapped labels
 *  (Intimacy Director, Wig/Hair/Makeup Designer, Fight Director, …) are dropped
 *  rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "musical director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "original choreographer": "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

interface ShowPost {
  id: number;
  slug: string;
  link: string;
}

export async function scrapeMinnesotaOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const candidates = await collectProductionPages(ctx, window.mode);
    for (const page of candidates) {
      try {
        const prod = await parseProduction(page, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`minnesota-opera: page ${page.slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("minnesota-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("minnesota-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "minnesota-opera", productions };
}

/** Subpage slugs that sit under a production but are not productions themselves.
 *  A page is only a candidate when its slug equals the last URL segment and that
 *  segment is NOT one of these — the composer gate downstream catches the rest. */
const SUBPAGE_SLUGS = new Set([
  "synopsis",
  "cast-and-creative-team",
  "cast-and-creative",
  "video-library",
  "artists-up-close",
  "directors-note",
  "directors-notes",
  "first-listen",
  "meet-the-artists",
  "blog-meet-the-artists",
  "behind-the-seams",
]);

/** Enumerate `op_shows` posts and keep the ones that look like a production page
 *  (`/season/{season}/{slug}/`, slug == last segment, not a known subpage). In
 *  incremental mode only the current and future seasons are walked so the daily
 *  run doesn't re-fetch the whole archive nightly; backfill walks everything. */
async function collectProductionPages(
  ctx: FetchContext,
  mode: ScrapeWindow["mode"],
): Promise<ShowPost[]> {
  const posts: ShowPost[] = [];
  for (let offset = 0; offset < 600; offset += 100) {
    const batch = await fetchJson<ShowPost[]>(
      `${BASE}/wp-json/wp/v2/op_shows?per_page=100&offset=${offset}&_fields=id,slug,link`,
      ctx,
    );
    if (batch.length === 0) break;
    posts.push(...batch);
    if (batch.length < 100) break;
  }

  const minSeason = mode === "incremental" ? currentSeasonStartYear() : 0;
  const out: ShowPost[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    const seg = seasonSegment(post);
    if (!seg) continue;
    const startYear = seasonStartYear(seg);
    if (startYear === null || startYear < minSeason) continue;
    if (seen.has(post.link)) continue;
    seen.add(post.link);
    out.push(post);
  }
  return out;
}

/** The season segment of a production link, or null when the page is a subpage
 *  or doesn't sit directly under a season. */
function seasonSegment(post: ShowPost): string | null {
  const parts = post.link.replace(/\/+$/, "").split("/");
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2] ?? "";
  if (last !== post.slug || SUBPAGE_SLUGS.has(last)) return null;
  // A production page nests directly under /season/{season}/ or /season/.
  if (prev === "season") return "season";
  return /^\d{4}-\d{4}/.test(prev) && parts[parts.length - 3] === "season" ? prev : null;
}

/** First calendar year of a `YYYY-YYYY` season segment (e.g. `2025-2026` → 2025).
 *  Top-level `/season/{slug}/` pages (segment "season") have no year — treated as
 *  unbounded (year 0) so backfill keeps them and incremental drops them. */
function seasonStartYear(segment: string): number | null {
  if (segment === "season") return 0;
  const m = segment.match(/^(\d{4})-\d{4}/);
  return m ? Number.parseInt(m[1] ?? "", 10) : null;
}

/** A US opera season starting in autumn belongs to the season whose first year is
 *  this calendar year (Aug+) or the previous one. Anchors the incremental cutoff. */
function currentSeasonStartYear(): number {
  const now = new Date();
  return now.getUTCMonth() + 1 >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

async function parseProduction(
  page: ShowPost,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(page.link, ctx);

  const info = infoBlock(html);
  if (!info) return null;

  const composer = parseComposer(info);
  // No structured composer ⇒ a gala/party/subscription/concert page that shares
  // the /season/ path. This is the real opera gate.
  if (!composer) return null;

  // "in concert" presentations are concert (not staged) performances — out of scope.
  const title = parseTitle(html, page.slug);
  if (!title || /\bin concert\b/i.test(title) || /-in-concert$/.test(page.slug)) return null;

  const seg = seasonSegment(page);
  // The headline run range sits in a sibling <h2> just above the info block.
  const subtitle = html.match(/sub-title["'][^>]*>([^<]+)</i)?.[1] ?? null;
  const performances = parsePerformances(info, subtitle, seg, window);
  if (performances.length === 0) return null;

  const { cast, creative_team } = await parseCredits(page, ctx);

  return {
    source_production_id: `minnesota-opera/${page.id}`,
    work_title: title,
    composer_name: composer,
    detail_url: page.link,
    cast,
    creative_team,
    performances,
  };
}

/** The `singleshow__main__info` block (the production's headline column), as raw
 *  HTML up to the sidebar. Both templates carry composer + dates inside it. */
function infoBlock(html: string): string | null {
  const m = html.match(
    /singleshow__main__info[^>]*>([\s\S]*?)(?:singleshow__sidebar|<div id=["']content|class=["']singleshow__sidebar)/,
  );
  return m ? (m[1] ?? null) : null;
}

/** Composer from the `MUSIC BY` / `MUSIC AND LIBRETTO BY` / `Music by` line. Tags
 *  are stripped first (the name can sit in nested spans), then the run is cut at
 *  the next role label (Libretto/Lyrics/Text/Based) so only the composer remains. */
function parseComposer(infoHtml: string): string | null {
  const text = stripHtml(infoHtml);
  // Cut the name at the next credit label (Libretto/Lyrics/Text/Based, with or
  // without "by") or the prose that follows; a name is short, so also cap length.
  const m = text.match(
    /MUSIC(?:\s+AND\s+LIBRETTO)?\s+BY\s+(.+?)(?=\s+(?:LIBRETTO|LYRICS|TEXT|BASED|AND\s+LIBRETTO)\b|[;:]|\s{2,}|$)/i,
  );
  const name = m?.[1]?.trim() ?? "";
  if (!name || !/[A-Za-z]/.test(name) || name.length > 60) return null;
  return normalizeName(name);
}

/** Pages headline names in ALL CAPS; title-case those so output reads naturally
 *  (mixed-case names are left as printed). Initials like "B.E." are preserved. */
function normalizeName(name: string): string {
  if (name !== name.toUpperCase()) return name;
  // Capitalize the first letter of each word; a word boundary here is the string
  // start or a non-letter (so accented letters mid-word stay lowercase).
  return name
    .toLowerCase()
    .replace(/(^|[^\p{L}])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

function parseTitle(html: string, slug: string): string | null {
  const h1 = html.match(/<h1[^>]*class=["']default__title["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const fromH1 = h1 ? stripHtml(decodeEntities(h1)) : "";
  if (fromH1) return fromH1;
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (og) return stripHtml(decodeEntities(og)).replace(/\s*[-–|]\s*Minnesota Opera\s*$/i, "");
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Performances from the info block. Current template: `Weekday, Month Day at
 *  7:30pm` nights (year inferred from the season). Older template: the headline
 *  date range — emit its start date as one performance. Honors window.since. */
function parsePerformances(
  infoHtml: string,
  subtitle: string | null,
  seasonSeg: string | null,
  window: ScrapeWindow,
): RawPerformance[] {
  const text = stripHtml(infoHtml);
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const push = (date: IsoDate, time: string | null) => {
    if (window.since && date < window.since) return;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ date, time, venue_room: VENUE, status: date < today ? "past" : "scheduled" });
  };

  for (const [, monthName, dayStr, timeStr] of text.matchAll(
    /(?:Sun|Mon|Tues?|Wed(?:nes)?|Thur?s?|Fri|Sat(?:ur)?)[a-z]*,?\s+([A-Za-z]+)\s+(\d{1,2})\s+at\s+([\d:]+\s*[ap]m)/gi,
  )) {
    const date = isoFor(monthName, dayStr ?? "", seasonSeg);
    if (date) push(date, parseTime(timeStr ?? ""));
  }

  if (out.length === 0 && subtitle) {
    const range = parseDateRange(subtitle);
    if (range) push(range, null);
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Build an ISO date for a year-less night from its month + the season segment:
 *  in a `YYYY-YYYY` season, autumn months (Aug+) fall in the first year, winter/
 *  spring in the second. */
function isoFor(
  monthName: string | undefined,
  dayStr: string,
  seasonSeg: string | null,
): IsoDate | null {
  const month = MONTHS[(monthName ?? "").toLowerCase()];
  if (!month || !seasonSeg) return null;
  const m = seasonSeg.match(/^(\d{4})-(\d{4})/);
  if (!m) return null;
  const monthNum = Number.parseInt(month, 10);
  const year = monthNum >= 8 ? m[1] : m[2];
  return isoFromParts(year ?? "", month, dayStr);
}

/** A headline run range (`May 7–22, 2022` / `April 30 – May 8, 2022`) → its start
 *  date. Older pages list no individual nights once tickets close. */
function parseDateRange(subtitle: string): IsoDate | null {
  const text = stripHtml(decodeEntities(subtitle));
  const m = text.match(/([A-Za-z]+)\s+(\d{1,2}).*?(\d{4})/);
  if (!m) return null;
  const month = MONTHS[(m[1] ?? "").toLowerCase()];
  if (!month) return null;
  return isoFromParts(m[3] ?? "", month, m[2] ?? "");
}

/** "7:30pm" / "2pm" / "10am" → 24h "HH:MM". */
function parseTime(text: string): string | null {
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])m/i);
  if (!m) return null;
  let hour = Number.parseInt(m[1] ?? "", 10);
  const meridian = (m[3] ?? "").toLowerCase();
  if (meridian === "p" && hour !== 12) hour += 12;
  if (meridian === "a" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m[2] ?? "00"}`;
}

/** Cast + creative team off the `/cast-and-creative-team/` subpage. Each `biolist`
 *  card is `<a>Name</a><br/>Role`; the `Cast` and `Creative Team` headings split
 *  the page (cast roles verbatim, creative labels mapped). Missing page ⇒ empty. */
async function parseCredits(
  page: ShowPost,
  ctx: FetchContext,
): Promise<{ cast: RawCredit[]; creative_team: RawCredit[] }> {
  const cast: RawCredit[] = [];
  const creative_team: RawCredit[] = [];
  let html: string;
  try {
    html = await fetchHtml(`${page.link.replace(/\/+$/, "")}/cast-and-creative-team/`, ctx);
  } catch {
    return { cast, creative_team };
  }

  const creativeStart = html.search(/operaTitle["'][^>]*>\s*Creative/i);
  const seenCast = new Set<string>();
  const seenCrew = new Set<string>();

  for (const m of html.matchAll(/biolist-text-div["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    const card = m[1] ?? "";
    const rawName = stripHtml(decodeEntities(card.match(/<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ""));
    if (!rawName) continue;
    const name = normalizeName(rawName);
    // The role/function is the first line after the name; further <br/> lines are
    // a job-title description (e.g. "MN Opera Principal Conductor") — ignore them.
    // Drop the resident-artist / faculty markers the page appends to cast roles.
    const after = card.replace(/^[\s\S]*?<\/a>\s*(?:<br\s*\/?>)*/i, "");
    const firstLine = after.split(/<br\s*\/?>/i)[0] ?? "";
    const label = stripHtml(decodeEntities(firstLine))
      .replace(/\s*[•*]\s*(?:Resident Artist|Repertory Artist[- ]Faculty).*$/i, "")
      .trim();
    if (!label) continue;

    const isCreative = creativeStart >= 0 && (m.index ?? 0) >= creativeStart;
    if (isCreative) {
      const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
      if (!fn) continue;
      const key = `${fn}|${name}`;
      if (seenCrew.has(key)) continue;
      seenCrew.add(key);
      creative_team.push({ function: fn, name });
    } else {
      const key = `${label}|${name}`;
      if (seenCast.has(key)) continue;
      seenCast.add(key);
      cast.push({ role: label, name });
    }
  }

  return { cast, creative_team };
}
