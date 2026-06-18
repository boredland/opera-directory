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
import { isoFromParts } from "./_dates";

/**
 * Glyndebourne Festival (`spielplan-html` strategy) — the English country-house
 * opera festival (Lewes, East Sussex). A FESTIVAL: one edition at a time (the
 * summer Festival, ~May–August) plus a separate autumn season; empty in winter.
 * Live scrape = the current edition's staged opera; `backfill` appends Wikidata.
 *
 * WordPress site behind CloudFront, which 403s the project crawler UA — so this
 * adapter overrides ctx.userAgent with a browser string (no proxy needed; the
 * block is UA-based, not IP-based). The page emits only Yoast SEO JSON-LD (no
 * schema.org Event), so everything is parsed from HTML:
 *   - The festival hub `/festival/` (and `/autumn/`) link to `/events/{slug}/`.
 *   - Each event's `heroBanner__hero__date` reads "{Composer} • {date range}";
 *     the part before the bullet IS the composer (ENGLISH byline, not the German
 *     composerFromText). A bare-date hero (no letters before the bullet) marks a
 *     concert, which we drop.
 *   - Credits sit in `<h2>Creative team</h2>` / `<h2>Cast includes</h2>` blocks of
 *     `<p>Label<br><span class="castHigher">Name</span></p>`. English function
 *     labels are mapped INSIDE this adapter (Conductor, Director, Set/Costume/
 *     Lighting Designer, Choreographer, …); unmapped labels in the cast block are
 *     sung roles. A staged opera always carries a Director credit — that's the
 *     filter that separates opera from concert/recital.
 *   - Performance dates live in `<div class="subheader subheader--small">` lists
 *     ("3, 6, 10 June"), each followed by an "Opera starts: H.MMpm" time. The year
 *     is absent on the page, so it's inferred from the hero range + festival year.
 */

const BASE = "https://www.glyndebourne.com";
/** Glyndebourne Festival Opera on Wikidata (the festival, NOT the place Q5572925
 *  or the former opera house Q58181522). Verified via wbsearchentities:
 *  Q203348 = "Glyndebourne Festival Opera", description "English opera festival". */
const WIKIDATA_QID = "Q203348";

/** CloudFront 403s the polite crawler UA; a browser UA gets HTTP 200. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Section hubs that list the current edition's `/events/{slug}/` pages. */
const SECTION_PATHS = ["/festival/", "/autumn/"];

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

/** English creative-team labels → our canonical function slugs. Glyndebourne
 *  prints several variants ("Set Designer", "Set & Costume Designer", "Revival
 *  Director", "Fight Directors") — fold the variants here so ingest sees a stable
 *  function. Any label NOT in this map that appears in the cast block is a role. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "staff director": "director",
  designer: "set-designer",
  "set designer": "set-designer",
  "set and costume designer": "set-designer",
  "set & costume designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "video designer": "video-designer",
  "projection designer": "projection-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "fight director": "fight-director",
  "fight directors": "fight-director",
  "chorus director": "chorus-master",
  "chorus master": "chorus-master",
  "children's chorus master": "chorus-master",
  dramaturg: "dramaturgy",
  leader: "leader",
};

export async function scrapeGlyndebourneFestival(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const browserCtx: FetchContext = { ...ctx, userAgent: BROWSER_UA };
  const productions: RawProduction[] = [];

  try {
    const slugs = await collectEventSlugs(browserCtx);
    for (const slug of slugs) {
      try {
        const html = await fetchHtml(`${BASE}/events/${slug}/`, browserCtx);
        const prod = parseEvent(html, slug);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`glyndebourne-festival: event ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("glyndebourne-festival: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, browserCtx, window)));
    } catch (err) {
      console.warn("glyndebourne-festival: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "glyndebourne-festival", productions };
}

/** Walk the section hubs, collecting unique `/events/{slug}/` slugs. */
async function collectEventSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  for (const path of SECTION_PATHS) {
    try {
      const html = await fetchHtml(`${BASE}${path}`, ctx);
      for (const [, slug] of html.matchAll(
        /href="https:\/\/www\.glyndebourne\.com\/events\/([^"/]+)\/"/g,
      )) {
        if (slug) slugs.add(slug);
      }
    } catch (err) {
      console.warn(`glyndebourne-festival: section ${path} failed:`, err);
    }
  }
  return [...slugs];
}

function parseEvent(html: string, slug: string): RawProduction | null {
  const hero = stripHtml(html.match(/heroBanner__hero__date">([\s\S]*?)<\/div>/)?.[1] ?? "");
  const composer = composerFromHero(hero);
  // A bare-date hero (no composer byline) is a concert/recital, not staged opera.
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(html);
  // Staged opera always credits a Director; concerts that slip past the hero test
  // (a named conductor billed before the bullet) do not. This is the opera filter.
  if (!creative_team.some((c) => c.function === "director")) return null;

  const performances = parsePerformances(html, festivalYear(hero));
  if (performances.length === 0) return null;

  const title =
    stripHtml(html.match(/<h1[^>]*class="[^"]*heroTitle"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "") ||
    slugToTitle(slug);
  if (!title) return null;

  return {
    source_production_id: `glyndebourne/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/events/${slug}/`,
    creative_team,
    cast,
    performances,
  };
}

/** Hero date reads "{Composer} • {range}". The composer is the text before the
 *  bullet, with any trailing "and librettist …" qualifier dropped. Returns null
 *  when that segment carries no letters (a bare-date hero ⇒ concert). */
function composerFromHero(hero: string): string | null {
  const head = hero.split(/[•·]/)[0]?.trim() ?? "";
  const composer = head.replace(/\s+and\s+librettist[\s\S]*$/i, "").trim();
  if (!composer || !/[A-Za-z]/.test(composer) || /^\d/.test(composer)) return null;
  return composer;
}

/** The festival year is the year of the hero range. The page omits it from the
 *  date lists, so it's the only place to read it; default to the current year. */
function festivalYear(hero: string): number {
  return Number.parseInt(hero.match(/\b(20\d{2})\b/)?.[1] ?? "", 10) || new Date().getFullYear();
}

function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const block of creditBlocks(html)) {
    for (const p of block.html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
      const inner = p[1] ?? "";
      // First text node (before the first <br> or <span>) is the label/role.
      const label = stripHtml(inner.split(/<br\s*\/?>|<span/i)[0] ?? "");
      // An ensemble (orchestra/chorus) is billed as the castHigher span itself with
      // its function (<em>Leader</em>) trailing — no leading label. Skip those.
      if (!label) continue;
      const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
      // In the creative-team block an unmapped label is still a production credit,
      // not a sung role — never let it leak into cast.
      if (!fn && block.kind === "creative") continue;

      for (const a of inner.matchAll(/<span class="castHigher">([\s\S]*?)<\/span>/g)) {
        for (const name of splitNames(a[1] ?? "")) {
          const key = `${fn ?? `role:${label}`}|${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (fn) creative_team.push({ function: fn, name });
          else cast.push({ role: label, name });
        }
      }
    }
  }
  return { creative_team, cast };
}

interface CreditBlock {
  kind: "creative" | "cast";
  html: string;
}

/** The "Creative team" and "Cast includes" blocks each run from their <h2> to the
 *  next closing wrapper `</div>` — far enough to hold the <p> credit list. */
function creditBlocks(html: string): CreditBlock[] {
  const blocks: CreditBlock[] = [];
  for (const m of html.matchAll(
    /<h2[^>]*>\s*(Creative team|Cast(?: includes)?)\s*<\/h2>([\s\S]*?)<\/div>/g,
  )) {
    if (m[2]) blocks.push({ kind: /^Creative/.test(m[1] ?? "") ? "creative" : "cast", html: m[2] });
  }
  return blocks;
}

/** A single castHigher span can hold several names joined by <br> (alternating
 *  casts / co-credits): "Bertie Baigent<br>Jack Gonzalez-Harding". Split them. */
function splitNames(span: string): string[] {
  return span
    .split(/<br\s*\/?>/i)
    .map(cleanName)
    .filter(Boolean);
}

/** Date lists sit in `subheader--small` divs ("3, 6, 10 June"); the matching
 *  start-time follows in the next "Opera starts: H.MMpm". Each list may span
 *  several months, the day reset (".. June 1 July") marking the month change. */
function parsePerformances(html: string, year: number): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/subheader subheader--small">([\s\S]*?)<\/div>/g)) {
    const text = stripHtml(m[1] ?? "");
    const dates = parseDateList(text, year);
    if (dates.length === 0) continue;

    const after = html.slice(m.index ?? 0, (m.index ?? 0) + 600);
    const time = parseTime(after.match(/Opera starts:\s*([\d.:]+)\s*([ap]m)/i));

    for (const date of dates) {
      const key = `${date}|${time ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date, time, status: status(date) });
    }
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** "21 & 30 May 3, 6, 10 June 1 July" → ISO dates. Walk left→right; a month word
 *  applies to the run of bare day numbers that precede it. */
function parseDateList(text: string, year: number): IsoDate[] {
  const cleaned = text.replace(/^Dates:\s*/i, "").replace(/&|\band\b/g, " ");
  const tokens = cleaned.match(/\d{1,2}|[A-Za-z]+/g) ?? [];
  const dates: IsoDate[] = [];
  let pendingDays: number[] = [];

  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const day = Number.parseInt(tok, 10);
      if (day >= 1 && day <= 31) pendingDays.push(day);
    } else {
      const month = MONTHS[tok.toLowerCase()];
      if (!month) {
        pendingDays = [];
        continue;
      }
      for (const day of pendingDays) {
        const d = isoFromParts(year, month, day);
        if (d) dates.push(d);
      }
      pendingDays = [];
    }
  }
  return dates;
}

/** "5.30pm" → "17:30"; "11.00am" → "11:00". */
function parseTime(m: RegExpMatchArray | null): string | null {
  if (!m) return null;
  const [h, min] = (m[1] ?? "").split(/[.:]/);
  let hour = Number.parseInt(h ?? "", 10);
  if (Number.isNaN(hour)) return null;
  const isPm = (m[2] ?? "").toLowerCase() === "pm";
  if (isPm && hour < 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${(min ?? "00").padStart(2, "0")}`;
}

/** Strip trailing alternate-cast markers (+, ‡, *) and a "(date)" qualifier. */
function cleanName(raw: string): string {
  return stripHtml(decodeEntities(raw))
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[*+‡†§]+\s*$/, "")
    .trim();
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function status(date: IsoDate): RawPerformance["status"] {
  return date < new Date().toISOString().slice(0, 10) ? "past" : "scheduled";
}
