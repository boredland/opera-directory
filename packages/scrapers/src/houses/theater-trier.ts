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
 * Theater Trier (`spielplan-html`, custom PHP CMS, server-rendered, no proxy).
 *
 * Use the `www.` host — the apex is a parking page. Two pages feed a scrape:
 *
 *   - /programm/index.html lists the CURRENT-season productions, one card per
 *     `produktion … grid-item`. Opera cards carry `sparte-15` (Musiktheater); the
 *     `<h3><a>` is the title and a "<p>{genre} von {Composer}</p>" subtitle yields
 *     the composer. This is only a title/composer hint, keyed by detail slug.
 *
 *   - The /spielplan AJAX calendar is the authoritative performance source. Its
 *     `filterFrom`/`filterUntil` params are ignored (every window returns the same
 *     fixed page) — navigation is purely by `&offset={page}`. offset 0 is the first
 *     batch, each increment is the next month-with-events; a month with no events
 *     comes back as a lone "\n" (skip, keep going) and the tail comes back as the
 *     literal "ende erreicht." Despite `filterSparte=15` the fragment is NOT
 *     opera-filtered, so each `vorstellung performance` row is kept only when it
 *     carries the `sparte-15` class. Rows give DD MM YY (year present), a
 *     "HH.MM[–HH.MM] Uhr" start time, a venue link, a reservix ticket link and a
 *     "Wiederaufnahme" revival marker.
 *
 * Productions are grouped by detail slug across the calendar (the calendar spans
 * seasons whose slugs differ from /programm, e.g. `my-fair-lady-2`), then enriched
 * from /produktionen/{slug}.html?m=47 for title, composer and credits. Future-only
 * source → Wikidata covers the deep past in backfill mode.
 */

const BASE = "https://www.theater-trier.de";
/** Theater Trier on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415967";

const MAX_CALENDAR_PAGES = 30;

export async function scrapeTheaterTrier(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const composerHints = await fetchProgrammHints(ctx);
    const { perfsBySlug, revivalSlugs } = await fetchCalendarPerformances(ctx, window);

    for (const [slug, performances] of perfsBySlug) {
      try {
        const prod = await buildProduction(ctx, slug, performances, {
          composer: composerHints.get(slug),
          isRevival: revivalSlugs.has(slug),
        });
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-trier: ${slug} detail failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-trier: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-trier: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-trier", productions };
}

/** /programm cards → slug → composer, for the opera (`sparte-15`) cards only.
 *  Concerts mis-tagged as Musiktheater (e.g. "Weihnachtskonzert") have no "… von
 *  {Composer}" subtitle, so requiring a composer drops them. */
async function fetchProgrammHints(ctx: FetchContext): Promise<Map<string, string>> {
  const hints = new Map<string, string>();
  const html = await fetchHtml(`${BASE}/programm/index.html`, ctx);

  for (const card of html.split("produktion maax grid-item").slice(1)) {
    const head = card.slice(0, 400);
    if (!/\bsparte-15\b/.test(head)) continue;
    const slug = card.match(/href="\.\/produktionen\/([a-z0-9-]+)\.html/)?.[1];
    if (!slug || hints.has(slug)) continue;
    const subtitle = stripHtml(card.match(/<p[^>]*>([^<]*\bvon\b[^<]*)<\/p>/i)?.[1] ?? "");
    const composer = composerFromText(subtitle);
    if (composer) hints.set(slug, composer);
  }
  return hints;
}

/** Walk the AJAX calendar by `offset`, collecting `sparte-15` performances grouped
 *  by detail slug. An empty page ("\n") is a no-event month — skip but keep going;
 *  "ende erreicht." (or an empty/rowless page past the data) ends the walk. */
async function fetchCalendarPerformances(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<{ perfsBySlug: Map<string, RawPerformance[]>; revivalSlugs: Set<string> }> {
  const today = new Date().toISOString().slice(0, 10);
  const perfsBySlug = new Map<string, RawPerformance[]>();
  const revivalSlugs = new Set<string>();
  const seen = new Set<string>();

  let emptyStreak = 0;
  for (let offset = 0; offset < MAX_CALENDAR_PAGES; offset++) {
    const url =
      `${BASE}/spielplan/index.html?ajax=1&filterIsSet=true&filterSparte=15` +
      `&filterFrom=${today}&offset=${offset}`;
    const fragment = await fetchHtml(url, ctx);

    if (fragment.trim() === "ende erreicht.") break;

    const rows = fragment.split('<div id="ID_Vorstellung_').slice(1);
    if (rows.length === 0) {
      // A no-event month returns a lone "\n"; two such in a row past the last
      // event means we've run off the end (defensive — the tail is "ende erreicht.").
      if (++emptyStreak >= 2) break;
      continue;
    }
    emptyStreak = 0;

    for (const row of rows) {
      const parsed = parseCalendarRow(row, today, window);
      if (!parsed) continue;
      const { slug, performance, isRevival } = parsed;
      if (isRevival) revivalSlugs.add(slug);
      const key = `${slug}|${performance.date}|${performance.time ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (perfsBySlug.get(slug) ?? perfsBySlug.set(slug, []).get(slug))?.push(performance);
    }
  }

  for (const performances of perfsBySlug.values()) {
    performances.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
  }
  return { perfsBySlug, revivalSlugs };
}

/** One `vorstellung performance` row → {slug, performance, isRevival}, or null when
 *  it isn't an opera (`sparte-15`) row or carries no parseable date. */
function parseCalendarRow(
  row: string,
  today: string,
  window: ScrapeWindow,
): { slug: string; performance: RawPerformance; isRevival: boolean } | null {
  const head = row.slice(0, 600);
  if (!/\bsparte-15\b/.test(head)) return null;

  const dm = head.match(/\bdate-(\d{2})(\d{2})(\d{2})\b/);
  if (!dm) return null;
  const date = `20${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
  if (window.since && date < window.since) return null;

  const slug = row.match(/href="\.\/produktionen\/([a-z0-9-]+)\.html\?/)?.[1];
  if (!slug) return null;

  const text = stripHtml(row);
  const tm = text.match(/(\d{1,2})\.(\d{2})(?:\s*[–-]\s*\d{1,2}\.\d{2})?\s*Uhr/);
  const time = tm ? `${tm[1]?.padStart(2, "0")}:${tm[2]}` : null;

  const venue = stripHtml(row.match(/ID_Ort=\d+"[^>]*>([^<]+)<\/a>/)?.[1] ?? "") || null;
  const ticket = row.match(/href="(https:\/\/[^"]*reservix[^"]+)"/)?.[1] ?? null;

  return {
    slug,
    isRevival: /wiederaufnahme/i.test(text),
    performance: {
      date,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
      ticket_url: ticket,
    },
  };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  performances: RawPerformance[],
  opts: { composer?: string; isRevival?: boolean },
): Promise<RawProduction | null> {
  if (performances.length === 0) return null;

  const url = `${BASE}/produktionen/${slug}.html?m=47`;
  const html = await fetchHtml(url, ctx);

  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!title) return null;

  // Genre/composer subtitle sits in the fw-bold block right after the <h1>.
  const subtitle = stripHtml(html.match(/fw-bold fs-5[^>]*>\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "");
  const composer = composerFromText(subtitle) ?? opts.composer ?? null;

  const { cast, creative } = parseCredits(html);
  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    is_revival: opts.isRevival,
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** `function_person` blocks: a `<span class="function">LABEL</span>` then a
 *  `<span class="fw-bold">NAME</span>`. The markup is malformed — names are not
 *  reliably closed (`Padberg</a></a>`, `Mergener</a>` with no closing fw-bold span)
 *  — so the name is captured up to the next tag. normalizeGermanCredit routes a
 *  known function label to the creative team; anything else is a sung role. */
function parseCredits(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];

  const re = /<span class="function\s*">([\s\S]*?)<\/span>[\s\S]*?<span class="fw-bold">([^<]+)/g;
  for (const m of html.matchAll(re)) {
    const label = stripHtml(m[1] ?? "");
    const name = decodeEntities((m[2] ?? "").replace(/\s+/g, " ")).trim();
    if (!label || !name) continue;
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative.push(credit);
    else cast.push(credit);
  }
  return { cast, creative };
}
