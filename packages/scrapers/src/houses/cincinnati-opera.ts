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
 * Cincinnati Opera (`spielplan-html` strategy) — the second-oldest opera company
 * in the US (Cincinnati, OH; US/English). A summer FESTIVAL: one compact season
 * each year, ~June–July, in Cincinnati Music Hall, dark the rest of the year. So
 * the live scrape is the current (already-announced) season and `backfill`
 * appends Wikidata for the deep past.
 *
 * Squarespace site. The home page's primary nav carries a "{year} Summer Festival"
 * folder whose subnav links each season page at a top-level `/{slug}`; the staged
 * operas sit alongside non-opera season items (Studio Sessions, community events,
 * the festival index), which the composer/date gate below drops. The page JSON-LD
 * is only Squarespace WebSite/Organization boilerplate (no Event/cast), so
 * everything comes from the SSR HTML:
 *   - title: `og:title` ("Carmen — Cincinnati Opera"), house suffix stripped.
 *   - dates + venue: one `<h2>` of `<br>`-separated lines — date lines like
 *     "July 25, 29 & 31, 2026 | 7:30 pm" (a day-list and a time-list both expand
 *     to one performance each) and a "Music Hall • {room}" venue line.
 *   - composer: the "Music by {Name}" / "Music and text by {Name}" line — an
 *     ENGLISH byline (NOT the German composerFromText), required as the opera gate.
 *   - cast + creative: a Squarespace gallery whose every image `alt` is
 *     "{Name} // {Role-or-function}". A role in CREATIVE_FUNCTIONS is a creative
 *     credit (English labels mapped in-adapter); any other role is sung cast.
 *
 * Opera filter: REQUIRE a composer AND ≥1 dated performance — concerts, the
 * Studio Sessions recital series, community events and the festival index page
 * all fail one of those tests.
 */

const BASE = "https://www.cincinnatiopera.org";
/** Cincinnati Opera on Wikidata — the opera COMPANY. Verified via wbsearchentities
 *  (action=wbsearchentities&search=Cincinnati Opera): Q5120283 = "Cincinnati
 *  Opera", description "non-profit organization in the USA". */
const WIKIDATA_QID = "Q5120283";

/** English cast-card role labels that are actually creative-team FUNCTIONS →
 *  our canonical function slugs. A gallery alt-role NOT in this map is treated as
 *  a sung role (cast). Original/associate/assistant variants fold onto the
 *  principal function; unmapped team labels (e.g. Wig & Makeup, Stage Manager)
 *  are dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "original stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "associate stage director": "director",
  "assistant director": "director",
  "assistant stage director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "scenic & costume designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeCincinnatiOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectSeasonSlugs(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}/${slug}`, ctx), slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`cincinnati-opera: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("cincinnati-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("cincinnati-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "cincinnati-opera", productions };
}

/** The home-page nav has a "{year} Summer Festival" folder; its subnav lists each
 *  season page at a top-level `/{slug}`. Collect those, dropping the index/utility
 *  pages by name — the composer/date gate drops any non-opera that survives. */
async function collectSeasonSlugs(ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(`${BASE}/`, ctx);
  const folder = html.match(
    /<div class="folder-toggle"[^>]*>\s*\d{4} Summer Festival\s*<\/div>\s*<div class="subnav">([\s\S]*?)(?:<div class="folder-toggle"|<div class="folder">|<\/nav>)/,
  )?.[1];
  if (!folder) return [];

  const slugs = new Set<string>();
  for (const [, slug] of folder.matchAll(/<a href="\/([a-z0-9-]+)"/g)) {
    if (slug && !/summer-festival|community-events|tickets$/.test(slug)) slugs.add(slug);
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const composer = parseComposer(html);
  // No composer ⇒ a recital/concert/community page that slipped through the nav.
  if (!composer) return null;

  const { dates, venue } = parseSchedule(html);
  const performances = parsePerformances(dates, venue, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html) || slugToTitle(slug);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `cincinnati-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    language: parseLanguage(html),
    detail_url: `${BASE}/${slug}`,
    creative_team,
    cast,
    performances,
  };
}

/** "Music by Georges Bizet" or "Music and text by Ricky Ian Gordon" — the byline
 *  runs to the line break / next tag. */
function parseComposer(html: string): string | null {
  const m = html.match(/Music(?:\s+and\s+(?:text|libretto))?\s+by\s+([^<\n]{2,80})/i);
  if (!m) return null;
  const composer = stripHtml(m[1] ?? "")
    .replace(/\s+and\s+.*$/i, "")
    .trim();
  return composer && /[A-Za-z]/.test(composer) ? composer : null;
}

/** The schedule lives in one `<h2>` of `<br>`-separated lines: one or more date
 *  lines ("July 25, 29 & 31, 2026 | 7:30 pm") and a "Music Hall • {room}" venue
 *  line. Returns the raw date lines + the venue string. */
function parseSchedule(html: string): { dates: string[]; venue: string | null } {
  let venue: string | null = null;
  const dates: string[] = [];
  for (const m of html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)) {
    const lines = (m[1] ?? "").split(/<br\s*\/?>/i).map((l) => stripHtml(l));
    for (const line of lines) {
      if (/music hall/i.test(line) && !/\d{4}/.test(line)) {
        venue = line.replace(/\s*[•·]\s*/g, " — ").trim();
      } else if (MONTH_LINE.test(line)) {
        dates.push(line);
      }
    }
    if (dates.length) break;
  }
  return { dates, venue };
}

const MONTH_NAMES =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTH_LINE = new RegExp(`^(?:${MONTH_NAMES})\\b`, "i");

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

/**
 * Expand each date line into performances. A line is
 * "{Month} {d}[, {d} & {d}], {year} | {time}[ & {time}]": the day-list and the
 * time-list each multiply out, so "July 28 & 30, 2026 | 3:00 pm & 8:00 pm" is
 * four nights. Honors window.since; venue is the shared room.
 */
function parsePerformances(
  dateLines: string[],
  venue: string | null,
  window: ScrapeWindow,
): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const line of dateLines) {
    const m = line.match(
      new RegExp(`(${MONTH_NAMES})\\s+([\\d,\\s&]+?),?\\s+(\\d{4})\\s*(?:\\|\\s*(.+))?$`, "i"),
    );
    if (!m) continue;
    const month = MONTHS[(m[1] ?? "").toLowerCase()];
    const year = m[3];
    if (!month || !year) continue;
    const days = (m[2] ?? "").match(/\d{1,2}/g) ?? [];
    const times = parseTimes(m[4] ?? "");

    for (const day of days) {
      const date = `${year}-${month}-${day.padStart(2, "0")}` as IsoDate;
      if (window.since && date < window.since) continue;
      for (const time of times.length ? times : [null]) {
        const key = `${date}|${time ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          date,
          time,
          venue_room: venue,
          status: date < today ? "past" : "scheduled",
        });
      }
    }
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** "7:30 pm" / "3:00 pm & 8:00 pm" → ["19:30"] / ["15:00", "20:00"]. */
function parseTimes(text: string): (string | null)[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(\d{1,2}):(\d{2})\s*(am|pm)/gi)) {
    let hour = Number.parseInt(m[1] ?? "", 10);
    const meridian = (m[3] ?? "").toLowerCase();
    if (meridian === "pm" && hour !== 12) hour += 12;
    if (meridian === "am" && hour === 12) hour = 0;
    out.push(`${String(hour).padStart(2, "0")}:${m[2]}`);
  }
  return out;
}

/** Production-credit keywords that mark an alt-role as a team credit, not a sung
 *  role — used to DROP unmapped team labels (Composer, Librettist, Wig & Makeup,
 *  Stage Manager, Orchestrator…) rather than mis-file them as cast. */
const CREDIT_LABEL =
  /\b(?:composer|librettist|conductor|director|designer|master|choreographer|dramaturg|orchestrator|copyist|manager|supervisor|coach|repetiteur)\b/i;

/**
 * Cast + creative share one Squarespace gallery; each artist is an image whose
 * `alt` is "{Name} // {Role-or-function}". A role in CREATIVE_FUNCTIONS becomes a
 * mapped creative credit; a role that otherwise reads as a production credit is
 * dropped (unmapped); everything else is a sung role (cast). The two house typos
 * that swap name/role ("A Slave // Clara Reeves") are emitted verbatim — staying
 * faithful, the resolver sorts oddities.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, alt] of html.matchAll(/alt="([^"]*\/\/[^"]*)"/g)) {
    const [namePart, rolePart] = decodeEntities(alt ?? "").split("//");
    const name = (namePart ?? "").trim();
    const role = (rolePart ?? "").trim();
    if (!name || !role) continue;

    const fn = CREATIVE_FUNCTIONS[role.toLowerCase()];
    if (fn) {
      const key = `c|${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    } else if (CREDIT_LABEL.test(role)) {
    } else {
      const key = `r|${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role, name });
    }
  }
  return { creative_team, cast };
}

function parseTitle(html: string): string | null {
  const og = html.match(/property="og:title"\s+content="([^"]*)"/i)?.[1];
  if (!og) return null;
  return (
    decodeEntities(og)
      .replace(/\s*[—–-]\s*Cincinnati Opera\s*$/i, "")
      .trim() || null
  );
}

/** "Sung in French with projected English translations" → ISO 639-1. */
function parseLanguage(html: string): RawProduction["language"] {
  const first = html.match(/Sung in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
  if (!first) return null;
  return (
    ({
      italian: "it",
      english: "en",
      german: "de",
      french: "fr",
      russian: "ru",
      czech: "cs",
      spanish: "es",
    }[first] as RawProduction["language"]) ?? null
  );
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
