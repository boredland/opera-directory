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
 * Teatro Real, Madrid (`spielplan-html` strategy) — Spain's leading opera house.
 *
 * Drupal site, Spanish-language with an `/en/` mirror; we read the `/es/` pages.
 * The current season already separates its strands by URL
 * (`/temporada-actual/{opera,danza,conciertos,flamenco-real,…}`), so the live
 * leg fetches ONLY the opera index (`/es/temporada-actual/opera`) and follows
 * its `/es/espectaculo/{slug}` show links — ballet/dance/concerts/flamenco/
 * recitals never enter the set.
 *
 * One show detail page yields everything for a production:
 *   - composer from the description byline "Música de {X}" (SPANISH — the German
 *     composerFromText is not used; the byline is parsed locally below);
 *   - performances from the `functions-show__block` list (one block per night:
 *     a Spanish-month date "10 diciembre 2025", an hour "19:30", a venue room
 *     "Sala Principal", and a `sold-out`/"agotadas" marker);
 *   - creative team from the `lista-artistas` rows (`<span class="…-text">Label
 *     </span><span class="…-title">Name</span>`), whose Spanish function labels
 *     map to our slugs via CREATIVE_LABELS;
 *   - cast from the "Reparto" grid (`<span class="position">Role</span>
 *     <span class="title">Singer</span>`).
 *
 * Opera gate: a real staged opera carries a "Música de {X}" composer byline.
 * Promo/info pages and the orchestra-tour concert that share the espectáculo
 * URL space have no such byline and are dropped (composer is required).
 *
 * `backfill` appends Wikidata (Q211250) for the deep past the live site drops.
 */

const BASE = "https://www.teatroreal.es";
const OPERA_INDEX = `${BASE}/es/temporada-actual/opera`;

/** Teatro Real on Wikidata — the OPERA HOUSE in Madrid (Q211250), not the
 *  Teatro Real theatre company (Q108892001). Verified via wbsearchentities
 *  ("opera house in Madrid, Spain") and EntityData: P31 includes opera house
 *  (Q153562), P856 website = https://www.teatroreal.es, located in Madrid. */
const WIKIDATA_QID = "Q211250";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/** Spanish creative-function labels → canonical function slugs, tested in order.
 *  The site combines roles in one label ("Escenografía y vestuario"); a director
 *  rule precedes set/costume so a "Dirección de escena y …" reads as director. */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/dirección del coro|director(a)? del coro|maestro del coro/i, "chorus-master"],
  [/dirección musical|director(a)? musical/i, "conductor"],
  [/dirección de escena|director(a)? de escena/i, "director"],
  [/coreograf/i, "choreographer"],
  [/iluminación|diseño de iluminación/i, "lighting"],
  [/escenograf/i, "set-designer"],
  [/vestuario|figurines/i, "costume-designer"],
  [/dramaturg/i, "dramaturgy"],
];

const SPANISH_MONTHS: Record<string, string> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  setiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

export async function scrapeTeatroReal(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const indexHtml = await fetchHtml(OPERA_INDEX, ctx);
    const since = effectiveSince(window);

    for (const detailUrl of showUrls(indexHtml)) {
      try {
        const prod = await buildProduction(ctx, detailUrl, since);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-real: ${detailUrl} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-real: opera index scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-real: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-real", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** Distinct `/es/espectaculo/{slug}` links from the opera index (hrefs carry
 *  stray whitespace, so trim before deduping). */
function showUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const [, href] of html.matchAll(/href="\s*([^"]*\/es\/espectaculo\/[^"#?]+?)\s*"/g)) {
    if (href) urls.add(href.trim().replace(/\/$/, ""));
  }
  return [...urls];
}

async function buildProduction(
  ctx: FetchContext,
  detailUrl: string,
  since: IsoDate | null,
): Promise<RawProduction | null> {
  const html = await fetchHtml(detailUrl, ctx);

  const composer = parseComposer(html);
  if (!composer) return null;

  const title = parseTitle(html);
  if (!title) return null;

  const performances = parsePerformances(html, since);
  if (performances.length === 0) return null;

  return {
    source_production_id: detailUrl.split("/").pop() ?? detailUrl,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: detailUrl,
    creative_team: parseCreativeTeam(html),
    cast: parseCast(html),
    performances,
  };
}

/** Title is the page `<h1>`; fall back to the JSON-LD Event name. */
function parseTitle(html: string): string | null {
  const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (h1) return h1;
  const ld = html.match(/"@type"\s*:\s*"Event"[\s\S]*?"name"\s*:\s*"([^"]+)"/);
  return ld ? decodeEntities(ld[1] ?? "").trim() || null : null;
}

/** Composer from the description byline "<strong>Música </strong>de {Name}".
 *  Trailing birth-year parens and a year range are dropped; an empty result
 *  (no byline) gates out the non-opera espectáculo pages. */
function parseComposer(html: string): string | null {
  const m = html.match(/Música\s*<\/strong>\s*de(?:&nbsp;|\s)+([^<(]+)/i);
  if (!m) return null;
  const name = decodeEntities(m[1] ?? "")
    .replace(/\s+/g, " ")
    .replace(/[,;]?\s*\(?\d{4}.*$/, "")
    .trim();
  return name || null;
}

/** Performances from the `functions-show__block` list — one block per night,
 *  with a Spanish-month date, an hour, a venue room, and a sold-out marker. */
function parsePerformances(html: string, since: IsoDate | null): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const re =
    /<div class="functions-show__block(\s+sold-out)?">([\s\S]*?)<div class="functions-show__block--item-prices/g;
  for (const [, soldOut, block] of html.matchAll(re)) {
    const date = parseSpanishDate(
      stripHtml(block?.match(/item-date">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? ""),
    );
    if (!date || (since && date < since)) continue;
    const time = stripHtml(block?.match(/item-hour">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "").match(
      /\d{1,2}:\d{2}/,
    )?.[0];
    const room = stripHtml(block?.match(/item-space">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "") || null;

    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time: time ?? null,
      venue_room: room,
      status: soldOut ? "sold_out" : date < today ? "past" : "scheduled",
    });
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/** "10 diciembre 2025" → "2025-12-10". */
function parseSpanishDate(text: string): IsoDate | null {
  const m = text.match(/(\d{1,2})\s+([a-záéíóú]+)\s+(\d{4})/i);
  if (!m) return null;
  const day = m[1]?.padStart(2, "0");
  const month = SPANISH_MONTHS[(m[2] ?? "").toLowerCase()];
  if (!month || !day) return null;
  return `${m[3]}-${month}-${day}` as IsoDate;
}

/** Creative team from `lista-artistas` rows whose Spanish label maps to a
 *  canonical function. Ensemble rows (Coro / Orquesta) carry no mapped label
 *  and are dropped. A label may list several people split by " / ". */
function parseCreativeTeam(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  const re =
    /<li class="lista-artistas"[^>]*>\s*<span class="lista-artistas-text">([\s\S]*?)<\/span>\s*<span class="lista-artistas-title">([\s\S]*?)<\/span>/g;
  for (const [, rawLabel, rawName] of html.matchAll(re)) {
    const fn = mapFunction(stripHtml(rawLabel ?? ""));
    if (!fn) continue;
    for (const name of splitNames(stripHtml(rawName ?? ""))) {
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ function: fn, name });
    }
  }
  return out;
}

/** Cast from the "Reparto" grid: `<span class="position">Role</span>
 *  <span class="title">Singer</span>` (one row per role per alternate). The
 *  following "Equipo artístico" grid reuses the same markup for the creative
 *  team (already captured from `lista-artistas`), so the scan is bounded to the
 *  Reparto section to keep function labels out of the cast. */
function parseCast(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  const start = html.indexOf("<h3>Reparto</h3>");
  if (start < 0) return out;
  const tail = html.slice(start);
  const end = tail.indexOf("<h3>", 16);
  const section = end > 0 ? tail.slice(0, end) : tail;
  const re = /<span class="position">([\s\S]*?)<\/span>\s*<span class="title">([\s\S]*?)<\/span>/g;
  for (const [, rawRole, rawName] of section.matchAll(re)) {
    const role = stripHtml(rawRole ?? "");
    const name = stripHtml(rawName ?? "");
    if (!role || !name) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name });
  }
  return out;
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A credit value may list alternates split by " / "; drop ensemble names. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*\/\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/orquesta|\bcoro\b|filarmón|ensemble/i.test(s));
}

/** Spanish opera seasons run Sep–Jul: a Dec 2025 performance is "2025/26". */
function seasonOf(date: IsoDate | null | undefined): string | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (!year || !month) return null;
  const start = month >= 8 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}
