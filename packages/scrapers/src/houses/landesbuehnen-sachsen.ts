import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, proxyFetch, stripHtml } from "../fetch";
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
 * Landesbühnen Sachsen, Radebeul (`json-api`, WordPress + a custom "lbs-gersoft"
 * spielplan plugin, no proxy) — a touring state stage near Dresden that also
 * plays the open-air Felsenbühne Rathen and guest towns across Saxony.
 *
 * The spielplan is loaded client-side via admin-ajax (`action=lbs_get_spielplan`,
 * no nonce required), which returns one flat JSON row PER PERFORMANCE: a `Datum`
 * (DD.MM.YYYY), `Von` (HH:MM), the work `Stueck` + a `UTitel` genre/author line
 * ("Romantische Oper von Carl Maria von Weber"), a per-performance `Location`
 * venue, a `stueckGUID` (production key), `StueckLink` (detail path) and
 * `findetStatt` (1 = takes place). We group rows by `stueckGUID`, keep only
 * productions whose `UTitel` is Oper/Operette/Singspiel AND yields a composer,
 * then fetch each /spielzeit/{slug}/ detail page (server-rendered) for the cast:
 * an `<ul class="lbs_besetzung">` of `lbs_besetzung_rolle` (German label) +
 * `lbs_besetzung_name` (one or more `<a>`/text names, `<br>`-joined alternates).
 * Touring house → venue varies per performance. Future/season → Wikidata backfill.
 */

const BASE = "https://www.landesbuehnen-sachsen.de";
const AJAX = `${BASE}/wp-admin/admin-ajax.php`;
/** Landesbühnen Sachsen on Wikidata — verified Radebeul touring theatre/opera company. */
const WIKIDATA_QID = "Q1802153";
/** UTitel genre prefixes we treat as opera/operetta (Singspiel = operetta-adjacent). */
const OPERA_GENRE = /\b(Oper|Operette|Singspiel)\b/;
/** Musical/Rocktheater carry an "Oper"-free genre word but slip past on composer; drop them. */
const NON_OPERA = /\b(Musical|Rocktheater|Familienmusical)\b/i;

interface SpielplanRow {
  Datum: string;
  Von: string | null;
  Stueck: string;
  UTitel: string | null;
  stueckGUID: string;
  StueckLink: string | null;
  Location: string | null;
  findetStatt: string;
}

export async function scrapeLandesbuehnenSachsen(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const rows = await fetchSpielplan(ctx);
    for (const group of groupByProduction(rows)) {
      try {
        const prod = await buildProduction(ctx, group, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`landesbuehnen-sachsen: ${group.stueckGUID} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("landesbuehnen-sachsen: spielplan failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("landesbuehnen-sachsen: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "landesbuehnen-sachsen", productions };
}

async function fetchSpielplan(ctx: FetchContext): Promise<SpielplanRow[]> {
  const res = await proxyFetch(AJAX, ctx.proxy, {
    method: "POST",
    headers: {
      "User-Agent": ctx.userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "action=lbs_get_spielplan&showfilter=1&stueckguid=&ortguid=&projectguid=&kollegenguid=&abo=&limit=&filtervars=",
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`ajax failed: ${AJAX} → ${res.status}`);
  return (await res.json()) as SpielplanRow[];
}

interface ProductionGroup {
  stueckGUID: string;
  title: string;
  subtitle: string;
  slug: string | null;
  rows: SpielplanRow[];
}

/** Collapse the flat per-performance rows into one group per `stueckGUID`. */
function groupByProduction(rows: SpielplanRow[]): ProductionGroup[] {
  const byProd = new Map<string, ProductionGroup>();
  for (const row of rows) {
    let group = byProd.get(row.stueckGUID);
    if (!group) {
      const link = row.StueckLink && row.StueckLink !== "#" ? row.StueckLink : null;
      group = {
        stueckGUID: row.stueckGUID,
        title: stripHtml(row.Stueck),
        subtitle: stripHtml(row.UTitel ?? ""),
        slug: link?.replace(/^\/spielzeit\//, "").replace(/\/$/, "") || null,
        rows: [],
      };
      byProd.set(row.stueckGUID, group);
    }
    group.rows.push(row);
  }
  return [...byProd.values()];
}

async function buildProduction(
  ctx: FetchContext,
  group: ProductionGroup,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  if (NON_OPERA.test(group.subtitle) || !OPERA_GENRE.test(group.subtitle)) return null;
  const composer = composerFromText(group.subtitle);
  if (!group.title || !composer) return null;

  const performances = parsePerformances(group.rows, window);
  if (performances.length === 0) return null;

  const detailUrl = group.slug ? `${BASE}/spielzeit/${group.slug}/` : null;
  let cast: RawCredit[] = [];
  let creative: RawCredit[] = [];
  if (detailUrl) {
    try {
      ({ cast, creative } = parseBesetzung(await fetchHtml(detailUrl, ctx)));
    } catch (err) {
      console.warn(`landesbuehnen-sachsen: detail ${group.slug} failed:`, err);
    }
  }

  return {
    source_production_id: group.stueckGUID,
    work_title: group.title,
    composer_name: composer,
    presentation_note: group.subtitle || null,
    detail_url: detailUrl,
    creative_team: creative,
    cast,
    performances,
  };
}

function parsePerformances(rows: SpielplanRow[], window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const row of rows) {
    const dm = row.Datum.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (!dm) continue;
    const date = `${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
    const time = row.Von?.match(/^\d{1,2}:\d{2}$/) ? row.Von : null;
    const key = `${date}|${time}|${row.Location ?? ""}`;
    if ((window.since && date < window.since) || seen.has(key)) continue;
    seen.add(key);
    performances.push({
      date,
      time,
      venue_room: stripHtml(row.Location ?? "") || null,
      status: row.findetStatt === "0" ? "cancelled" : date < today ? "past" : "scheduled",
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** `<ul class="lbs_besetzung">` rows: a `lbs_besetzung_rolle` label + a
 *  `lbs_besetzung_name` holding one or more `<br>`-joined names (alternates).
 *  A label in the German credit map is a creative function, anything else a
 *  sung role. Chor/Orchester/Tanz ensemble rows and footnote labels are dropped. */
function parseBesetzung(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];

  for (const m of html.matchAll(
    /lbs_besetzung_rolle">([\s\S]*?)<\/span>\s*<span class="lbs_besetzung_name">([\s\S]*?)<\/span>/g,
  )) {
    const label = stripHtml(m[1] ?? "").replace(/\s*\*+\s*$/, "");
    if (!label || /^\**$/.test(label) || /^(Chor|Extrachor|Orchester|Tanz)$/i.test(label)) continue;
    for (const namePart of (m[2] ?? "").split(/<br\s*\/?>/)) {
      const name = stripHtml(namePart);
      if (!name) continue;
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}
