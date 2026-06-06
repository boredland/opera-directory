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
 * The Atlanta Opera (`spielplan-html` strategy) — US opera company in Atlanta,
 * Georgia (OPERA America Tier-1; season ~Sep–May on the Cobb Energy Performing
 * Arts Centre main stage plus a smaller "Discoveries" series in other venues).
 * The live scrape is the current + announced season; `backfill` appends Wikidata.
 *
 * WordPress (Yoast). The `/whats-on/` index links every production at
 * `/production/{slug}/` (a season-package teaser also lives at `/performances/`,
 * carries no data, and is filtered out downstream). The page JSON-LD is only
 * Yoast WebPage/Organization — no Event/cast — so everything comes from SSR HTML:
 *   - composer: the "<strong>Composer:</strong> {Name}" (or "Composer &
 *     Librettist" / "Composer + Librettist") line in the `composerlibrettistpremier_info`
 *     box — an ENGLISH structured field (NOT German composerFromText).
 *   - cast + creative: `cast-person` cards. A plain card carries a `.character`
 *     (the sung role) → cast; a `dams-ao-23k-creative-team` card carries a `.role`
 *     (the function label, mapped in-adapter via CREATIVE_FUNCTIONS) → creative.
 *   - performances: `tickets-box-column` rows — `.day` ("Sat, November 8, 2025")
 *     + `.time` ("7:30 pm"). Ticket anchors are inert (purchase is off-site), so
 *     status is past/scheduled by date. Venue is the page's `.venue-link` text.
 *
 * Opera filter: REQUIRE a composer. The non-opera "Discoveries"/play-with-music
 * items (e.g. *All is Calm*) publish no Composer field and fail this test, as do
 * the data-less season teasers.
 */

const BASE = "https://www.atlantaopera.org";
/** The Atlanta Opera on Wikidata — the opera COMPANY. Verified via
 *  wbsearchentities: Q16162233 = "Atlanta Opera", description "opera company in
 *  Atlanta, Georgia, USA". */
const WIKIDATA_QID = "Q16162233";

/** English creative-team labels (the card `.role` text) → our canonical function
 *  slugs. Assistant/associate/live-action variants fold onto the principal
 *  function; unmapped labels (Wig/Makeup/Fight Director, etc.) are dropped rather
 *  than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "assistant conductor": "conductor",
  director: "director",
  "stage director": "director",
  "production director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "scenic designer": "set-designer",
  "set designer": "set-designer",
  "associate scenic designer": "set-designer",
  "scenic & projection designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  "projection & video designer": "projection-designer",
  choreographer: "choreographer",
  "associate choreographer": "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeAtlantaOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectProductionSlugs(ctx)) {
      try {
        const prod = parseProduction(
          await fetchHtml(`${BASE}/production/${slug}/`, ctx),
          slug,
          window,
        );
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`atlanta-opera: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("atlanta-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("atlanta-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "atlanta-opera", productions };
}

/** The `/whats-on/` index links every staged production at `/production/{slug}/`.
 *  The homepage carries the same set, so it's a cheap fallback when the index moves. */
async function collectProductionSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  for (const path of ["/whats-on/", "/"]) {
    try {
      const html = await fetchHtml(`${BASE}${path}`, ctx);
      for (const [, slug] of html.matchAll(
        /href="https:\/\/www\.atlantaopera\.org\/production\/([^"/]+)\/"/g,
      )) {
        if (slug) slugs.add(slug);
      }
    } catch (err) {
      console.warn(`atlanta-opera: index ${path} failed:`, err);
    }
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const composer = parseComposer(html);
  // No composer ⇒ a "Discoveries"/play-with-music item or a data-less season
  // teaser, not staged opera. This is the opera filter.
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html) || slugToTitle(slug);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `atlanta-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(html),
    detail_url: `${BASE}/production/${slug}/`,
    creative_team,
    cast,
    performances,
  };
}

/** "<strong>Composer:</strong> Giacomo Puccini<br>" — the label varies
 *  ("Composer", "Composer & Librettist", "Composer + Librettist"); the value
 *  runs to the next tag or HTML entity. */
function parseComposer(html: string): string | null {
  const m = html.match(/<strong>\s*Composer[^:<]*:\s*<\/strong>\s*([^<&]+)/i);
  const composer = m ? stripHtml(m[1] ?? "").trim() : "";
  return composer && /[A-Za-z]/.test(composer) ? composer : null;
}

function parseTitle(html: string): string | null {
  const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  if (og) {
    const title = decodeEntities(og.replace(/\s*[-–|]\s*The Atlanta Opera\s*$/i, "")).trim();
    if (title) return title;
  }
  const h2 = stripHtml(html.match(/<h2>([\s\S]*?)<\/h2>/)?.[1] ?? "");
  return h2 || null;
}

/**
 * Cast + creative share the `cast-person` card markup; the discriminator is the
 * inner label div: a plain card has `.character` (the sung role) and is cast; a
 * `dams-ao-23k-creative-team` card has `.role` (the function label) and is
 * creative. The name is the card's `.name` (optionally an `<a>`).
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, classes, body] of html.matchAll(
    /<div class='(cast-person[^']*)'>([\s\S]*?)(?=<div class='cast-person|<\/section|<h3|$)/g,
  )) {
    const name = stripHtml((body ?? "").match(/<div class='name'>([\s\S]*?)<\/div>/)?.[1] ?? "");
    if (!name) continue;

    const isCreative = /creative-team/.test(classes ?? "");
    if (isCreative) {
      const label = stripHtml((body ?? "").match(/<div class='role'>([\s\S]*?)<\/div>/)?.[1] ?? "");
      const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
      if (!fn) continue;
      const key = `c|${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    } else {
      const role = stripHtml(
        (body ?? "").match(/<div class='character'>([\s\S]*?)<\/div>/)?.[1] ?? "",
      );
      if (!role) continue;
      const key = `r|${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role, name });
    }
  }
  return { creative_team, cast };
}

/** Performance rows are `tickets-box-column` cells: `.day` ("Sat, November 8,
 *  2025") + `.time` ("7:30 pm"). Tickets are sold off-site (anchors inert), so
 *  status is derived from the date. Venue is the page's single `.venue-link`. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const venue = stripHtml(html.match(/class='venue-link'[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "") || null;
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, day, time] of html.matchAll(
    /<span class='day'>([^<]+)<\/span><span class='time'>([^<]*)<\/span>/g,
  )) {
    const date = parseDate(day ?? "");
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

/** "Sat, November 8, 2025" → "2025-11-08". */
function parseDate(text: string): IsoDate | null {
  const m = text.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[(m[1] ?? "").toLowerCase()];
  if (!month) return null;
  const day = (m[2] ?? "").padStart(2, "0");
  return `${m[3]}-${month}-${day}` as IsoDate;
}

/** "7:30 pm" / "3:00 pm" → 24h "HH:MM"; null when no time is printed. */
function parseTime(text: string): string | null {
  const m = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  let hour = Number.parseInt(m[1] ?? "", 10);
  const meridian = (m[3] ?? "").toLowerCase();
  if (meridian === "pm" && hour !== 12) hour += 12;
  if (meridian === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

/** The detail page prints "Sung in Italian with English supertitles." */
function languageCode(html: string): RawProduction["language"] {
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
  return slug
    .replace(/-\d{4}$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
