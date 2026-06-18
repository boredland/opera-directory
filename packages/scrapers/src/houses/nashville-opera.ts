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
 * Nashville Opera (`spielplan-html` strategy) — a US regional opera company
 * (Nashville, TN; US/English) staging a small mainstage season at TPAC's Andrew
 * Jackson Hall plus chamber/contemporary work in The Studio at the Noah Liff
 * Opera Center. The live scrape is the announced season; `backfill` appends
 * Wikidata for the deep past (the site's `/past-seasons/` page is poster images
 * with no per-production detail pages, so history isn't scrapable from the house).
 *
 * WordPress + Elementor page builder. Each staged opera is a top-level page
 * (`/{slug}/`) linked from the `/season/` index (and the homepage). The page
 * JSON-LD is only Yoast WebPage/Organization — no Event/cast — so everything
 * comes from the SSR HTML, which Elementor renders as a flat run of `text-editor`
 * widgets (`<p>…</p>`):
 *   - A "Quick Details" run of label→value pairs: `MUSIC` (the composer; REQUIRED
 *     — the opera gate), `DIRECTION`, `CONDUCTOR`, `Chorus Master`, etc. Labels are
 *     ENGLISH and mapped to our slugs in-adapter via CREATIVE_FUNCTIONS; the
 *     metadata labels (LANGUAGE/VENUE/…) bound the run and yield language + venue.
 *   - A Cast run of name→role pairs after the metadata block (a "TBD" placeholder
 *     name is dropped), up to the "What to Know" block (LOCATION/PARKING/…).
 *   - Performances: a "Performance Dates" block ("Thursday, Oct. 8, 2026 – 7:30
 *     PM") — the only place per-night dates render. Tickets are sold off-site, so
 *     status is past/scheduled by date.
 *
 * Opera filter: REQUIRE a composer (the `MUSIC` field). Non-staged events
 * (galas, the Jukebox Live cabaret fundraiser, donor pages) publish no MUSIC
 * field and fail this test.
 */

const BASE = "https://nashvilleopera.org";
/** Nashville Opera on Wikidata — the opera COMPANY (Q6966984 = "Nashville Opera
 *  Association", instance-of opera company P31=Q215380, HQ Nashville, founded
 *  1981, website nashvilleopera.org). Verified via wbsearchentities + EntityData.
 *  Wikidata currently lists zero productions for this QID, so the backfill is a
 *  no-op today but kept for when coverage improves. */
const WIKIDATA_QID = "Q6966984";

/** Non-production pages linked from the season index / homepage. */
const NON_PRODUCTION_SLUGS = new Set([
  "season",
  "season-packages",
  "past-seasons",
  "people",
  "education",
  "emerging-artists",
  "support",
  "contact",
  "board",
  "history",
  "newsletter",
  "jobs",
  "volunteer",
  "teachers",
  "production-rentals",
  "all-access-opera",
  "marian",
  "wheels",
  "ontour",
  "friends-of-nashville-opera",
  "impresario-council",
  "corporate-sponsors",
  "title-vi",
  "nashville-opera-at-cheekwood",
  "jukeboxlive",
]);

/** English "Quick Details" credit labels → our canonical function slugs.
 *  Unmapped labels (Rehearsal Accompanist, Orchestra Contractor, Librarian, …)
 *  are dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  direction: "director",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "lighting design": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

/** Metadata labels that bound the credit run and start the cast run. The cast
 *  run begins after AGE RATING's value; LOCATION starts the trailing "What to
 *  Know" block. */
const METADATA_LABELS = new Set(["language", "run time", "venue", "featuring", "age rating"]);

export async function scrapeNashvilleOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectProductionSlugs(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}/${slug}/`, ctx), slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`nashville-opera: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("nashville-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("nashville-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "nashville-opera", productions };
}

/** The `/season/` index links each production at a top-level `/{slug}/`; the
 *  homepage carries the same set as a fallback. Known non-production pages are
 *  filtered, and the composer gate drops any non-opera page that slips through. */
async function collectProductionSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  for (const path of ["/season/", "/"]) {
    try {
      const html = await fetchHtml(`${BASE}${path}`, ctx);
      for (const [, slug] of html.matchAll(
        /href="https:\/\/nashvilleopera\.org\/([a-z0-9-]+)\/"/g,
      )) {
        if (slug && !NON_PRODUCTION_SLUGS.has(slug) && !slug.startsWith("wp-")) slugs.add(slug);
      }
    } catch (err) {
      console.warn(`nashville-opera: index ${path} failed:`, err);
    }
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const widgets = textEditorWidgets(html);
  const composer = fieldValue(widgets, "music");
  // No MUSIC field ⇒ a gala / fundraiser / donor page, not staged opera. Opera gate.
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html, slug);
  if (!title) return null;

  return {
    source_production_id: `nashville-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(fieldValue(widgets, "language")),
    detail_url: `${BASE}/${slug}/`,
    image_url: parseImage(html),
    synopsis: parseSynopsis(widgets),
    creative_team: parseCreative(widgets),
    cast: parseCast(widgets),
    performances,
  };
}

/** The ordered plain-text content of every Elementor `text-editor` widget — the
 *  flat run that carries Quick Details (label/value pairs), the cast (name/role
 *  pairs), and the What-to-Know block. */
function textEditorWidgets(html: string): string[] {
  const out: string[] = [];
  for (const [, inner] of html.matchAll(
    /data-widget_type="text-editor\.default">\s*([\s\S]*?)\s*<\/div>/g,
  )) {
    const text = stripHtml(inner ?? "");
    if (text) out.push(text);
  }
  return out;
}

/** Look up a Quick-Details label's value: the widget right after the label. */
function fieldValue(widgets: string[], label: string): string | null {
  for (let i = 0; i < widgets.length - 1; i++) {
    if ((widgets[i] ?? "").trim().toLowerCase() === label) {
      const value = (widgets[i + 1] ?? "").trim();
      return value && /[A-Za-z]/.test(value) ? value : null;
    }
  }
  return null;
}

/** The credit run is the label/value pairs from MUSIC up to the first metadata
 *  label (LANGUAGE). Each label is mapped via CREATIVE_FUNCTIONS; MUSIC/LIBRETTO
 *  and unmapped labels are skipped. */
function parseCreative(widgets: string[]): RawCredit[] {
  const start = widgets.findIndex((w) => w.trim().toLowerCase() === "music");
  if (start < 0) return [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();
  for (let i = start; i < widgets.length - 1; i += 2) {
    const label = (widgets[i] ?? "").trim().toLowerCase();
    if (METADATA_LABELS.has(label)) break;
    const name = (widgets[i + 1] ?? "").trim();
    const fn = CREATIVE_FUNCTIONS[label];
    if (!fn || !name || !/[A-Za-z]/.test(name)) continue;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creative.push({ function: fn, name });
  }
  return creative;
}

/** Cast is the name/role pairs after AGE RATING's value, up to the LOCATION label
 *  that opens the trailing What-to-Know block. A "TBD" placeholder name is dropped. */
function parseCast(widgets: string[]): RawCredit[] {
  const ageIdx = widgets.findIndex((w) => w.trim().toLowerCase() === "age rating");
  if (ageIdx < 0) return [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (let i = ageIdx + 2; i < widgets.length - 1; i += 2) {
    const name = (widgets[i] ?? "").trim();
    if (name.toLowerCase() === "location") break;
    const role = (widgets[i + 1] ?? "").trim();
    if (!name || !role || /^tbd$/i.test(name)) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cast.push({ role, name });
  }
  return cast;
}

/** The synopsis blurb is the long lead text widget; an inline "Performance Dates"
 *  tail (parsed separately for the dates) is trimmed off. */
function parseSynopsis(widgets: string[]): string | null {
  for (const w of widgets.slice(0, 3)) {
    if (w.length > 80) return w.replace(/\s*Performance Dates[\s\S]*$/i, "").trim() || null;
  }
  return null;
}

function parseTitle(html: string, slug: string): string | null {
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (og) {
    const title = decodeEntities(og.replace(/\s*[-–|]\s*Nashville Opera\s*$/i, "")).trim();
    if (title) return title;
  }
  return slugToTitle(slug);
}

function parseImage(html: string): string | null {
  return html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1] ?? null;
}

/**
 * Performances live in a "Performance Dates" block: a venue line followed by one
 * line per night, e.g. "Thursday, Oct. 8, 2026 – 7:30 PM". The block ends at the
 * closing tag of the containing element. Honors window.since.
 */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const blockMatch = html.match(/Performance Dates[\s\S]*?<\/b>([\s\S]*?)<\/p>/i);
  const block = blockMatch
    ? decodeEntities((blockMatch[1] ?? "").replace(/<br\s*\/?>/gi, "\n"))
    : "";
  const venue = (block.split("\n")[0] ?? "").replace(/<[^>]+>/g, "").trim() || null;
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, month, day, year, time] of block.matchAll(
    /(?:[A-Za-z]+,\s*)?([A-Za-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})\s*[–-]\s*(\d{1,2}:\d{2}\s*[AP]M)/gi,
  )) {
    const date = isoDate(month ?? "", day ?? "", year ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;
    const hhmm = parseTime(time ?? "");
    const key = `${date}|${hhmm ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time: hhmm,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  sept: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** "Oct." / "October", "8", "2026" → "2026-10-08". */
function isoDate(month: string, day: string, year: string): IsoDate | null {
  const key = month
    .replace(/\.$/, "")
    .toLowerCase()
    .slice(0, month.toLowerCase().startsWith("sept") ? 4 : 3);
  const mm = MONTHS[key];
  if (!mm) return null;
  return isoFromParts(year, mm, day);
}

/** "7:30 PM" / "3:00 PM" → 24h "HH:MM". */
function parseTime(text: string): string | null {
  const m = text.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  let hour = Number.parseInt(m[1] ?? "", 10);
  const meridian = (m[3] ?? "").toUpperCase();
  if (meridian === "PM" && hour !== 12) hour += 12;
  if (meridian === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

/** "Italian with English supertitles" / "English" → ISO 639-1 of the sung language. */
function languageCode(text: string | null): RawProduction["language"] {
  if (!text) return null;
  const first = text.match(/[A-Za-z]+/)?.[0]?.toLowerCase();
  return (
    ({
      italian: "it",
      english: "en",
      german: "de",
      french: "fr",
      russian: "ru",
      czech: "cs",
      spanish: "es",
    }[first ?? ""] as RawProduction["language"]) ?? null
  );
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
