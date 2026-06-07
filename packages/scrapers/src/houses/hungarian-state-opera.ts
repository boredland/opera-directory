import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Hungarian State Opera — Magyar Állami Operaház (`spielplan-html` strategy), the
 * national opera company of Hungary, performing at the Opera House (Andrássy út)
 * and the Erkel Theatre, with chamber work at the Eiffel Art Studios. Tier-1
 * international house. The site (opera.hu) is Hungarian-first but ships a full
 * `/en/` mirror, which we prefer so the credit labels arrive in English.
 *
 * The company stages opera AND ballet AND concerts/recitals/galas from one
 * programme, so the adapter is gated to STAGED OPERA on two signals read off each
 * production page:
 *   - a genre tag — the `project-cover-category` tag list carries a genre word
 *     ("Opera", "Romantic opera", "Singspiel" → kept; "Fairy tale ballet",
 *     "Cantata", "Concert", "Aria and song recital", "Opera exam" → dropped). See
 *     isStagedOpera().
 *   - a composer — the "Authors" block's `Composer` row. Required (the opera gate
 *     proper); a page with no composer is not a staged work. composerFromText is
 *     German-only and deliberately unused — the label is read from this structured
 *     row, not inferred.
 *
 * Discovery is the `/en/programme/all/` index plus its per-season variants
 * (`?evad=YYYY-YYYY`), which list every production as `/en/programme/{season}/
 * {slug}/`. We walk the announced seasons (current + the next two) for the future
 * leg; the deep past comes from the Wikidata backfill, since the index only
 * surfaces announced seasons.
 *
 * Per-page data (server-rendered HTML — no JSON-LD, no inline state):
 *   - Composer/title — the "Authors" block and the `<h1>`.
 *   - Credits + cast — `block-list` sections labelled "Creative team" (function →
 *     person, English labels mapped INSIDE this adapter) and "General cast"
 *     (role → singer). A non-person "Featuring …" ensemble note is skipped.
 *   - Performances — the "Performance dates and ticket purchase" block: each night
 *     carries `post-start-date` ("2026. June"), `post-start-day` ("19."), a
 *     `post-time` ("Friday<br>18:00 – 21:45") and `post-location-name` (the venue
 *     room: "Hungarian State Opera" / "Erkel Theatre" / an Eiffel stage). Honors
 *     window.since.
 */

const BASE = "https://www.opera.hu";
const WIKIDATA_QID = "Q36833";

/** English creative-team labels → our canonical function slugs, with a Hungarian
 *  fallback for any row the `/en/` mirror leaves untranslated. An unmapped label is
 *  dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  director: "director",
  "stage director": "director",
  "set designer": "set-designer",
  "set and costume designer": "set-designer",
  "scenic designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  lighting: "lighting",
  choreographer: "choreographer",
  "chorus director": "chorus-master",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
  // Hungarian fallbacks.
  karmester: "conductor",
  rendező: "director",
  díszlet: "set-designer",
  jelmez: "costume-designer",
  világítás: "lighting",
  koreográfus: "choreographer",
  karigazgató: "chorus-master",
};

/** Genre words (lower-cased tag text) that mark a STAGED OPERA. "Opera exam" is a
 *  student exam, not a house staging, and is excluded — only a bare "opera"-family
 *  genre or "singspiel" passes. */
const OPERA_GENRES = /^(.*\bopera\b.*|singspiel)$/;
const NON_OPERA_GENRES = /\bexam\b/;

export async function scrapeHungarianStateOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const { season, slug } of await collectProductionPaths(ctx)) {
      const path = `/en/programme/${season}/${slug}/`;
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}${path}`, ctx), {
          season,
          slug,
          window,
        });
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`hungarian-state-opera: production ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("hungarian-state-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("hungarian-state-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "hungarian-state-opera", productions };
}

interface ProductionPath {
  season: string;
  slug: string;
}

/** The `/programme/all/` index lists the current season; `?evad=YYYY-YYYY` swaps in
 *  another announced season. We sweep the current season and the next two so the
 *  future leg captures everything announced. Each detail link is
 *  `/en/programme/{season}/{slug}/`. */
async function collectProductionPaths(ctx: FetchContext): Promise<ProductionPath[]> {
  const seen = new Set<string>();
  const out: ProductionPath[] = [];
  for (const season of announcedSeasons()) {
    let html: string;
    try {
      html = await fetchHtml(`${BASE}/en/programme/all/?evad=${season}`, ctx);
    } catch (err) {
      console.warn(`hungarian-state-opera: index ${season} failed:`, err);
      continue;
    }
    for (const [, s, slug] of html.matchAll(/href="\/en\/programme\/(\d{4}-\d{4})\/([^"/]+)\//g)) {
      if (!s || !slug) continue;
      const key = `${s}/${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ season: s, slug });
    }
  }
  return out;
}

/** The season spanning today plus the next two (Hungarian seasons run Aug–Jul). */
function announcedSeasons(): string[] {
  const now = new Date();
  const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return [0, 1, 2].map((d) => `${startYear + d}-${startYear + d + 1}`);
}

function parseProduction(
  html: string,
  opts: { season: string; slug: string; window: ScrapeWindow },
): RawProduction | null {
  const { season, slug, window } = opts;

  if (!isStagedOpera(html)) return null;

  const composer = parseAuthor(html, "Composer");
  // No composer ⇒ not a staged opera (or a non-production landing page). Opera gate.
  if (!composer) return null;

  const title = parseTitle(html, slug);
  if (!title) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `hungarian-state-opera/${season}/${slug}`,
    work_title: title,
    composer_name: composer,
    premiere_season: season.replace("-", "/"),
    detail_url: `${BASE}/en/programme/${season}/${slug}/`,
    image_url: parseOgImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** True when the production's genre tags mark a staged opera (see OPERA_GENRES). */
function isStagedOpera(html: string): boolean {
  const block = html.match(/project-cover-category[^>]*>([\s\S]*?)<\/div>/)?.[1];
  if (!block) return false;
  for (const [, tag] of block.matchAll(/class="tag tag--large[^"]*"[^>]*>([\s\S]*?)<\/span>/g)) {
    const genre = stripHtml(decodeEntities(tag ?? "")).toLowerCase();
    if (!genre || NON_OPERA_GENRES.test(genre)) continue;
    if (OPERA_GENRES.test(genre)) return true;
  }
  return false;
}

/** Read an "Authors"-block person by its role label ("Composer" / "Librettist"). */
function parseAuthor(html: string, role: string): string | null {
  const re = new RegExp(
    `post-role">${role}</div>\\s*<div class="post-person">[\\s\\S]*?post-person-name"[^>]*>([\\s\\S]*?)</a>`,
  );
  const name = stripHtml(html.match(re)?.[1] ?? "");
  return name || null;
}

function parseTitle(html: string, slug: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  const title = h1 ? stripHtml(h1) : "";
  return title || slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseOgImage(html: string): string | null {
  const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  return m?.[1] ?? null;
}

/** The `<ul class="block-list" aria-label="…">` section's inner HTML, or "". */
function blockSection(html: string, label: string): string {
  const re = new RegExp(`<ul class="block-list"\\s+aria-label="${label}">([\\s\\S]*?)</ul>`);
  return html.match(re)?.[1] ?? "";
}

/** Each `<li class="post">` row in a block is one "role → person" pair. */
function parseRows(section: string): { role: string; name: string }[] {
  const rows: { role: string; name: string }[] = [];
  for (const [, body] of section.matchAll(/<li class="post">([\s\S]*?)<\/li>/g)) {
    if (!body) continue;
    const role = stripHtml(decodeEntities(body.match(/post-role">([\s\S]*?)<\/div>/)?.[1] ?? ""));
    const name = stripHtml(
      decodeEntities(body.match(/post-person-name"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ""),
    );
    if (role && name) rows.push({ role, name });
  }
  return rows;
}

/** Creative team + cast from the two `block-list` sections. A row whose label maps
 *  via CREATIVE_FUNCTIONS is creative team (the Conductor sits in the "General cast"
 *  block at this house, so both sections feed the same split); every other "General
 *  cast" row is "role → singer". Unmapped "Creative team" labels (translation lines,
 *  etc.) and non-person "Featuring …" notes are dropped. */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  const consider = (section: string, allowCast: boolean) => {
    for (const { role, name } of parseRows(section)) {
      if (!isPersonName(name)) continue;
      const fn = CREATIVE_FUNCTIONS[role.toLowerCase()];
      if (fn) {
        const key = `${fn}|${name}`;
        if (seenCreative.has(key)) continue;
        seenCreative.add(key);
        creative_team.push({ function: fn, name });
      } else if (allowCast && role.length <= 60) {
        const key = `${role}|${name}`;
        if (seenCast.has(key)) continue;
        seenCast.add(key);
        cast.push({ role, name });
      }
    }
  };

  consider(blockSection(html, "Creative team"), false);
  consider(blockSection(html, "General cast"), true);

  return { creative_team, cast };
}

function isPersonName(name: string): boolean {
  return name.length > 1 && name.length <= 60 && /\p{L}/u.test(name) && !/[.!?:]/.test(name);
}

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

/** Performances are the rows of the "Performance dates and ticket purchase" block:
 *  `post-start-date` ("2026. June") + `post-start-day` ("19.") give the date,
 *  `post-time` ("Friday<br>18:00 – 21:45") the start time, and `post-location-name`
 *  the venue room. Honors window.since; status is past/scheduled by date. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const section = blockSection(html, "Performance dates and ticket purchase");
  if (!section) return [];

  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const re =
    /post-start-date">([^<]+)<\/span>\s*<span class="post-start-day">([^<]+)<\/span>\s*<time class="post-time">([\s\S]*?)<\/time>([\s\S]*?)<\/li>/g;
  for (const [, dateLabel, dayLabel, timeLabel, tail] of section.matchAll(re)) {
    const date = parseDate(dateLabel ?? "", dayLabel ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;

    const time = (timeLabel ?? "").match(/(\d{1,2}):(\d{2})/);
    const venue = stripHtml(decodeEntities(tail?.match(/post-location-name">([^<]+)</)?.[1] ?? ""));

    const key = `${date}|${time?.[0] ?? ""}|${venue}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date,
      time: time ? `${pad(Number(time[1]))}:${time[2]}` : null,
      venue_room: venue || null,
      status: date < today ? "past" : "scheduled",
    });
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** "2026. June" + "19." → "2026-06-19". */
function parseDate(dateLabel: string, dayLabel: string): IsoDate | null {
  const ym = dateLabel.match(/(\d{4})\.\s*([A-Za-z]+)/);
  const day = dayLabel.match(/(\d{1,2})/);
  const month = MONTHS[ym?.[2]?.toLowerCase() ?? ""];
  if (!ym || !day || !month) return null;
  return `${ym[1]}-${pad(month)}-${pad(Number(day[1]))}` as IsoDate;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
