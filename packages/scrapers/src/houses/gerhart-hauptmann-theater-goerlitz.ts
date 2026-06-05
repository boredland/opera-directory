import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Gerhart-Hauptmann-Theater Görlitz-Zittau (`spielplan-html`, BLUEPAGE CMS,
 * server-rendered, no proxy). A two-city house — performances play in Görlitz
 * *and* Zittau; the city lives inside the venue string, which we keep verbatim.
 *
 * /de/spielplan-musiktheater/ is one page covering the whole season, already
 * Musiktheater-filtered. Each `div.entry` carries everything needed for a
 * performance: the `a.link.idx > span` title, a detail href whose path encodes
 * the ISO date (`/{slug}/{YYYY-MM-DD}/{eventId}/`), a genre/composer `<em>`, and
 * a pipe-separated trailing `<div>` ("HH:MM Uhr | Venue | duration"). We sub-filter
 * to opera/operette via the `<em>` genre and group dates by {slug}. One detail
 * page per production is fetched for the `besetzung` accordion (cast + creative).
 * Future-only season → Wikidata backfill for the past.
 */

const BASE = "https://www.g-h-t.de";
/** Gerhart-Hauptmann-Theater Görlitz-Zittau on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1441837";

const OPERA_GENRE = /oper|operette|opéra|rockoper/i;

/** The genre `<em>` sometimes appends a "| Deutschsprachige Erstaufführung" note; the
 *  composer sits in the segment before that pipe, so extract from there. */
function composerFromGenre(genre: string): string | null {
  return composerFromText(genre.split("|")[0] ?? genre);
}

interface ListingEntry {
  slug: string;
  date: IsoDate;
  detailUrl: string;
  title: string;
  genre: string;
  time: string | null;
  venue: string | null;
}

export async function scrapeGerhartHauptmannTheaterGoerlitz(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const html = await fetchHtml(`${BASE}/de/spielplan-musiktheater/`, ctx);
    const grouped = groupBySlug(parseListing(html), window);
    for (const [slug, entries] of grouped) {
      try {
        productions.push(await buildProduction(ctx, slug, entries));
      } catch (err) {
        console.warn(`gerhart-hauptmann-theater-goerlitz: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("gerhart-hauptmann-theater-goerlitz: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("gerhart-hauptmann-theater-goerlitz: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "gerhart-hauptmann-theater-goerlitz", productions };
}

/** Each performance is one `div.entry`; the listing carries title/genre/date/time/venue. */
function parseListing(html: string): ListingEntry[] {
  const entries: ListingEntry[] = [];
  const re =
    /<a href="https:\/\/www\.g-h-t\.de\/de\/spielplan-musiktheater\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/(\d+)\/"\s+class="link idx"[^>]*><span>([\s\S]*?)<\/span><\/a>\s*<em>([\s\S]*?)<\/em>\s*<div>([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(re)) {
    const [, slug, date, , title, em, info] = m;
    if (!slug || !date) continue;
    const tokens = stripHtml(info ?? "").split("|");
    const time = (tokens[0]?.match(/(\d{1,2}:\d{2})/)?.[1] ?? null) as string | null;
    entries.push({
      slug,
      date: date as IsoDate,
      detailUrl: `${BASE}/de/spielplan-musiktheater/${slug}/${date}/${m[3]}/`,
      title: stripHtml(title ?? ""),
      genre: stripHtml(em ?? ""),
      time,
      venue: stripHtml(tokens[1] ?? "") || null,
    });
  }
  return entries;
}

/** Keep opera/operette only (and a parseable composer), then group dates by {slug}. */
function groupBySlug(entries: ListingEntry[], window: ScrapeWindow): Map<string, ListingEntry[]> {
  const grouped = new Map<string, ListingEntry[]>();
  for (const e of entries) {
    if (!OPERA_GENRE.test(e.genre)) continue;
    if (!composerFromGenre(e.genre)) continue;
    if (window.since && e.date < window.since) continue;
    const list = grouped.get(e.slug);
    if (list) list.push(e);
    else grouped.set(e.slug, [e]);
  }
  return grouped;
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  entries: ListingEntry[],
): Promise<RawProduction> {
  const first = entries[0] as ListingEntry;
  const detailHtml = await fetchHtml(first.detailUrl, ctx);
  const { cast, creative } = parseBesetzung(detailHtml);
  return {
    source_production_id: slug,
    work_title: first.title,
    composer_name: composerFromGenre(first.genre),
    presentation_note: first.genre || null,
    detail_url: first.detailUrl,
    creative_team: creative,
    cast,
    performances: buildPerformances(entries),
  };
}

/** Dedupe a production's dates by date|time and mark past nights. */
function buildPerformances(entries: ListingEntry[]): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];
  for (const e of entries) {
    const key = `${e.date}|${e.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    performances.push({
      date: e.date,
      time: e.time,
      venue_room: e.venue,
      status: e.date < today ? "past" : "scheduled",
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** The `besetzung` accordion: the first `.box_txt` is cast (LABEL = role), the rest
 *  the creative team. Each entry is "LABEL<br>NAME[, NAME…]" split by "<br><br>".
 *  We classify per-entry via normalizeGermanCredit (mapped function → creative,
 *  else a sung role) so it's robust to the house mixing technical roles in. */
function parseBesetzung(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];

  const seg = html.match(
    /ght_detail_accordion besetzung([\s\S]*?)(?:<div class="[^"]*ght_detail_accordion(?! besetzung)|$)/,
  )?.[1];
  if (!seg) return { cast, creative };

  for (const box of seg.matchAll(/<div class="box_txt">([\s\S]*?)<\/div>/g)) {
    for (const entry of (box[1] ?? "").split(/<br>\s*<br>/)) {
      const [labelPart, namesPart] = splitLabel(entry);
      const label = cleanText(labelPart);
      if (!label) continue;
      for (const name of extractNames(namesPart)) {
        if (isOrchestra(name)) continue;
        const credit = normalizeGermanCredit(label, name);
        if (credit.function) creative.push(credit);
        else cast.push({ role: label, name });
      }
    }
  }
  return { cast, creative };
}

function splitLabel(entry: string): [string, string] {
  const idx = entry.indexOf("<br>");
  if (idx === -1) return [entry, ""];
  return [entry.slice(0, idx), entry.slice(idx + 4)];
}

/** Names are `<b>Name</b>` (guest) or `<a…><span>Name</span></a>` (ensemble), possibly
 *  comma-separated or `/`-separated alternates with a trailing "(16.05.26)" date note. */
function extractNames(namesHtml: string): string[] {
  const names: string[] = [];
  for (const m of namesHtml.matchAll(/<b>([\s\S]*?)<\/b>|<span>([\s\S]*?)<\/span>/g)) {
    const name = cleanText(m[1] ?? m[2] ?? "");
    if (name) names.push(name);
  }
  return names;
}

function cleanText(html: string): string {
  return stripHtml(html.replace(/&shy;/g, ""))
    .replace(/\s*\(\d[^)]*\)\s*/g, " ") // drop alternate-cast date notes "(16.05.26)"
    .replace(/[/,]\s*$/, "")
    .trim();
}

/** Bare ensemble/orchestra entries (no individual performer) are dropped. */
function isOrchestra(name: string): boolean {
  return /philharmonie|orchester|chor\b|kapelle/i.test(name);
}
