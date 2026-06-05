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
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Theater Altenburg-Gera / Theater & Philharmonie Thüringen (`spielplan-html`,
 * TYPO3 `tx_theatre`, server-rendered, no proxy) — plays in Gera and Altenburg.
 *
 * The Musiktheater A–Z page /stuecke-konzerte/musiktheater/ lists one
 * `play-list-item` per production (link `stuecke-konzerte/{slug}-{uid}/`); a
 * season-dropdown exposes the other seasons (we walk each `seasonUid` URL). Detail:
 * `<h2>` title, a "{genre} von {Composer}" `p.subheading`, `event-head--item`
 * dates whose bold heading is "Wd DD. Mon YYYY · HH:MM · {Venue} {City}" (German
 * month; Gera/Altenburg in the venue string), and `ul.actors` lists of
 * `<span class="role">label</span><a>name</a>` — German labels → creative team,
 * character roles → sung cast. Musicals are dropped (subtitle genre); past-only
 * productions render no dates and are skipped. Future/season → Wikidata backfill.
 */

const BASE = "https://theater-altenburg-gera.de";
const LISTING = `${BASE}/stuecke-konzerte/musiktheater/`;
/** Theater Altenburg-Gera on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415675";
const GERMAN_MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mär: "03",
  mrz: "03",
  apr: "04",
  mai: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  okt: "10",
  nov: "11",
  dez: "12",
};

export async function scrapeTheaterAltenburgGera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(LISTING, ctx);
    // Walk the current season (default) + every other season in the dropdown.
    const seasonUrls = [
      ...new Set(
        index.match(
          /stuecke-konzerte\/musiktheater\/\?tx_theatre_playlist[^"']*seasonUid[^"']*/g,
        ) ?? [],
      ),
    ].map((u) => `${BASE}/${decodeEntities(u)}`);
    const pages = [index];
    for (const u of seasonUrls) {
      try {
        pages.push(await fetchHtml(u, ctx));
      } catch (err) {
        console.warn(`theater-altenburg-gera: season ${u} failed:`, err);
      }
    }

    const slugs = new Set<string>();
    for (const page of pages) {
      for (const it of page.split("play-list-item").slice(1)) {
        const slug = it.match(/href="(?:[^"]*\/)?stuecke-konzerte\/([a-z0-9-]+-\d+)\/"/)?.[1];
        if (slug) slugs.add(slug);
      }
    }
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-altenburg-gera: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-altenburg-gera: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-altenburg-gera: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-altenburg-gera", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/stuecke-konzerte/${slug}/`;
  const html = await fetchHtml(url, ctx);
  const subheading = stripHtml(html.match(/subheading">([\s\S]*?)<\/p>/)?.[1] ?? "");
  if (/\bmusical\b/i.test(subheading)) return null;
  const composer = composerFromText(subheading);
  const title = stripHtml(html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "");
  if (!title || !composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null; // past-only production

  const { cast, creative } = parseActors(html);
  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** Date headings read "Wd DD. Mon YYYY · HH:MM · {Venue} {City}" (· = U+00B7). */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  // Date, time and venue sit in separate spans joined by "·", so read a window
  // after each date heading and parse the flattened "DD. Mon YYYY · HH:MM · Venue".
  for (const m of html.matchAll(/is-uppercase is-bold">/g)) {
    const text = stripHtml(html.slice(m.index ?? 0, (m.index ?? 0) + 400));
    const dm = text.match(/(\d{1,2})\.\s*([A-Za-zä]+)\s*(\d{4})/);
    const month = dm ? GERMAN_MONTHS[(dm[2] ?? "").toLowerCase()] : undefined;
    if (!dm || !month) continue;
    const date = `${dm[3]}-${month}-${(dm[1] ?? "").padStart(2, "0")}` as IsoDate;
    const time = text.match(/·\s*(\d{1,2}:\d{2})/)?.[1] ?? null;
    if ((window.since && date < window.since) || seen.has(`${date}|${time}`)) continue;
    seen.add(`${date}|${time}`);
    // The window can cut a trailing label tag mid-string, so stop the venue at the
    // next "·", "<" or a Premiere/Wiederaufnahme marker.
    const venue =
      text
        .match(/·\s*\d{1,2}:\d{2}\s*·\s*([^·<]+)/)?.[1]
        ?.replace(/\s*(Premiere|Wiederaufnahme)\s*$/i, "")
        .trim() || null;
    performances.push({
      date,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** `ul.actors` rows: `<span class="role">label</span><a>name</a>` — a label in the
 *  German credit map is a creative function, anything else a sung role. Blank/
 *  "Ensembles" rows (orchestra/chorus) are skipped. */
function parseActors(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();

  for (const seg of html.match(/<ul class="actors[^"]*">([\s\S]*?)<\/ul>/g) ?? []) {
    for (const m of seg.matchAll(
      /<span class="role">([\s\S]*?)<\/span>\s*(?:<a[^>]*>([\s\S]*?)<\/a>|<span class="actor">([\s\S]*?)<\/span>)/g,
    )) {
      const label = stripHtml(m[1] ?? "");
      const name = stripHtml(m[2] ?? m[3] ?? "");
      if (!label || !name || /^ensembles?$/i.test(label)) continue;
      const key = `${label}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}
