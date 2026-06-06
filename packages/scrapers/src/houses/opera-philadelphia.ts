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
 * Opera Philadelphia (`spielplan-html` strategy) — a year-round US opera company
 * in Philadelphia, PA (US/English), staging its season on the Academy of Music
 * main stage plus the fall "Festival O". The live scrape is the announced
 * season(s); `backfill` appends Wikidata for the deep past.
 *
 * Umbraco CMS. Productions live under `/whats-on/{NNNN}-season/{slug}/`; the
 * season index pages (linked from the homepage + `/whats-on/`) enumerate them.
 * Each production page mixes two sources, both read here:
 *   - performances: schema.org `MusicEvent` JSON-LD (one node per night, with
 *     `startDate` local ISO + Academy of Music `location`). Only emitted for
 *     upcoming nights — past performances are dropped from the markup, so the
 *     deep past comes from Wikidata, not here.
 *   - composer + cast + creative: SSR HTML. The credit line is the
 *     `<p class="lower-space">` block ("Music by …" / "An opera by …" /
 *     "Music & Lyrics by …", with the libretto/book co-credits stripped); cast
 *     and creative are uniform `<figcaption>Name <span>Label</span></figcaption>`
 *     cards, where the span is an ENGLISH function label (mapped in-adapter via
 *     CREATIVE_FUNCTIONS) for creatives and the sung role for singers.
 *
 * Opera filter: REQUIRE a composer (the "… by" credit line). The non-opera items
 * sharing the season grid — recitals/concerts (only voice-type labels), galas,
 * and play-with-music pieces billed "Composer and Co-Creator" rather than
 * "Music by" — carry no such line and drop out.
 */

const BASE = "https://www.operaphila.org";
const VENUE = "Academy of Music";

/** Opera Philadelphia on Wikidata — the opera COMPANY. Verified via
 *  wbsearchentities: Q3378854 = "Opera Philadelphia", description "opera company
 *  in the USA". */
const WIKIDATA_QID = "Q3378854";

/** English creative-team labels (the figcaption `<span>` text) → our canonical
 *  function slugs. Revival/associate/assistant variants fold onto the principal
 *  function; an unmapped span is treated as a sung role (cast), not guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "assistant conductor": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "co-director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "production designer": "set-designer",
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

export async function scrapeOperaPhiladelphia(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const path of await collectProductionPaths(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}${path}`, ctx), path, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`opera-philadelphia: production ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("opera-philadelphia: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opera-philadelphia: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "opera-philadelphia", productions };
}

/** Discover `/whats-on/{NNNN}-season/{slug}/` production paths. The homepage and
 *  `/whats-on/` link the current + announced season indexes; each season index
 *  then lists its productions. Concerts/galas/recitals slip in but carry no
 *  composer and drop out in parseProduction. */
async function collectProductionPaths(ctx: FetchContext): Promise<string[]> {
  const seasonIndexes = new Set<string>(["/whats-on/"]);
  const paths = new Set<string>();

  for (const hub of ["/", "/whats-on/"]) {
    try {
      const html = await fetchHtml(`${BASE}${hub}`, ctx);
      for (const [, season] of html.matchAll(/href="(\/whats-on\/\d{4}-season\/)"/g)) {
        if (season) seasonIndexes.add(season);
      }
      collectSeasonProductions(html, paths);
    } catch (err) {
      console.warn(`opera-philadelphia: hub ${hub} failed:`, err);
    }
  }

  for (const index of seasonIndexes) {
    try {
      collectSeasonProductions(await fetchHtml(`${BASE}${index}`, ctx), paths);
    } catch (err) {
      console.warn(`opera-philadelphia: season index ${index} failed:`, err);
    }
  }

  return [...paths];
}

function collectSeasonProductions(html: string, into: Set<string>): void {
  for (const [, path] of html.matchAll(/href="(\/whats-on\/\d{4}-season\/[a-z][^"/]+\/)"/g)) {
    if (path) into.add(path);
  }
}

function parseProduction(html: string, path: string, window: ScrapeWindow): RawProduction | null {
  const composer = parseComposer(html);
  // No composer ⇒ a concert/recital/gala or a play-with-music item, not staged
  // opera. This is the opera filter.
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `opera-philadelphia${path.replace(/\/$/, "")}`,
    work_title: title,
    composer_name: composer,
    language: parseLanguage(html),
    detail_url: `${BASE}${path}`,
    creative_team,
    cast,
    performances,
  };
}

/** The credit line is the first `<p class="lower-space">` line that opens with a
 *  composer label ("Music by", "An opera by", "Music & Lyrics by", "Composer by",
 *  "Composed by"). The libretto/book/lyrics co-credit on the same line is
 *  stripped; when layout pushes the name onto the next line (multi-column billing,
 *  Gershwin), the next line's first `&nbsp;`-separated column is the composer. */
function parseComposer(html: string): string | null {
  const block = html.match(/<p class="lower-space">([\s\S]*?)<\/p>/i)?.[1];
  if (!block) return null;

  // Keep raw lines: a multi-column billing line separates names by &nbsp; runs,
  // which would collapse into one string once decoded.
  const rawLines = block.split(/<br\s*\/?>/i);
  for (let i = 0; i < rawLines.length; i++) {
    const label = collapse(decodeEntities((rawLines[i] ?? "").replace(/<[^>]+>/g, " ")));
    const m = label.match(
      /^(?:Music(?:\s*&\s*Lyrics)?|An opera|Composed|Composer)\s+by\b[:\s]*(.*)$/i,
    );
    if (!m) continue;

    const rest = (m[1] ?? "").replace(/\s*\b(?:Book|Libretto|Lyrics|Text)\s+by\b.*$/i, "").trim();
    if (rest) return rest;

    // Name spilled onto the next line; its first &nbsp;-separated column is the
    // composer (later columns are the book/lyrics authors of a co-billing).
    const cols = (rawLines[i + 1] ?? "")
      .split(/(?:&nbsp;\s*){2,}/i)
      .map((c) => collapse(decodeEntities(c.replace(/<[^>]+>/g, " "))))
      .filter(Boolean);
    if (cols.length && cols[0]) return cols[0];
  }
  return null;
}

/** The page `<h1 class="bigger">` carries the clean title; the og:title is doubled
 *  upstream ("Aida - Aida"), so it's only a fallback (de-duplicated). */
function parseTitle(html: string): string | null {
  const h1 = stripHtml(html.match(/<h1 class="bigger[^"]*">([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  if (h1) return h1;

  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (!og) return null;
  const title = decodeEntities(og.replace(/\s*[-–|]\s*Opera Philadelphia\s*$/i, "")).trim();
  return dedupeRepeat(title) || null;
}

/** Collapse an upstream-doubled title ("Aida - Aida") to a single instance. */
function dedupeRepeat(title: string): string {
  const m = title.match(/^(.+?)\s*[-–]\s*\1$/);
  return m?.[1] ?? title;
}

/**
 * Cast and creative share the `<figcaption>Name <span>Label</span></figcaption>`
 * card markup; the span discriminates. A label that maps in CREATIVE_FUNCTIONS is
 * a creative credit; any other label is the singer's sung role → cast. A trailing
 * "*" (role/house-debut marker) is stripped from names.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, body] of html.matchAll(/<figcaption>([\s\S]*?)<\/figcaption>/g)) {
    const labelHtml = (body ?? "").match(/<span>([\s\S]*?)<\/span>/)?.[1];
    if (labelHtml === undefined) continue;
    const label = stripHtml(labelHtml);
    const name = cleanName((body ?? "").split(/<span>/)[0] ?? "");
    if (!name || !label) continue;

    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    if (fn) {
      const key = `c|${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    } else {
      const key = `r|${label}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role: label, name });
    }
  }
  return { creative_team, cast };
}

interface MusicEvent {
  "@type"?: string;
  startDate?: string;
  location?: { name?: string };
  eventStatus?: string;
}

/** Performances are the `MusicEvent` JSON-LD nodes (one per upcoming night, with
 *  local-ISO `startDate`). Past nights are stripped from the markup upstream;
 *  honors window.since for the recent-past refresh that survives. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const node of musicEvents(html)) {
    const m = (node.startDate ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
    if (!m) continue;
    const date = m[1] as IsoDate;
    const time = m[2] ?? null;
    if (window.since && date < window.since) continue;

    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date,
      time,
      venue_room: node.location?.name ? stripHtml(node.location.name) : VENUE,
      status: eventStatus(node.eventStatus, date, today),
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Every `application/ld+json` blob flattened to its `MusicEvent` nodes. */
function musicEvents(html: string): MusicEvent[] {
  const events: MusicEvent[] = [];
  for (const [, raw] of html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse((raw ?? "").trim());
    } catch {
      continue;
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (node && (node as MusicEvent)["@type"] === "MusicEvent") events.push(node as MusicEvent);
    }
  }
  return events;
}

function eventStatus(status: unknown, date: IsoDate, today: string): RawPerformance["status"] {
  if (typeof status === "string" && /Cancelled/i.test(status)) return "cancelled";
  return date < today ? "past" : "scheduled";
}

/** The credit line prints "Performed in Italian with English supertitles." */
function parseLanguage(html: string): RawProduction["language"] {
  const first = html.match(/(?:Performed|Sung)\s+in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
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

/** Strip the trailing "*" debut marker and collapse whitespace. */
function cleanName(html: string): string {
  return stripHtml(html)
    .replace(/\s*\*+\s*$/, "")
    .trim();
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
