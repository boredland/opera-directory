import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, fetchRendered, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Staatstheater am Gärtnerplatz, München (`render` strategy).
 *
 * The spielplan (`/de/spielplan/index.html`) is JS-rendered: each performance is a
 * `<div class="… vorstellung performance produktion-{pid} … date-{DDMMYY} sparte-{n}
 * …">` whose `sparte-` class is the genre (14=Oper, 2=Operette — we keep those; 3=
 * Musical, 4=Ballett, 5=Konzert, 33=Opernstudio dropped) and which links to
 * `/de/produktionen/{slug}.html`. We render it (once) for the full season's dates,
 * group by slug, then fetch each server-rendered detail page for the title, composer
 * ("Musik von …") and the Besetzung (`function_person` rows: creative + sung cast).
 * Future-only → Wikidata backfill.
 */

const BASE = "https://www.gaertnerplatztheater.de";
const SPIELPLAN = `${BASE}/de/spielplan/index.html`;
/** Staatstheater am Gärtnerplatz on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q318058";

/** sparte- class IDs that are opera/operetta (vs. musical/ballet/concert/studio). */
const OPERA_SPARTE = new Set(["14", "2"]);

interface SpielplanEntry {
  perfs: RawPerformance[];
}

export async function scrapeStaatstheaterAmGaertnerplatz(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const html = await fetchRendered(SPIELPLAN, ctx, { waitMs: 5000 });
    const bySlug = parseSpielplan(html, window);
    for (const [slug, entry] of bySlug) {
      try {
        const prod = await buildProduction(ctx, slug, entry);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`staatstheater-am-gaertnerplatz: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("staatstheater-am-gaertnerplatz: spielplan render failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatstheater-am-gaertnerplatz: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatstheater-am-gaertnerplatz", productions };
}

/** One row per performance: `<div class="… vorstellung performance produktion-{pid}
 *  … date-{DDMMYY} sparte-{n} …">` with an inner `/de/produktionen/{slug}.html` link
 *  and a "HH.MM–HH.MM Uhr" time. Keep the opera/operetta sparten; group by slug. */
function parseSpielplan(html: string, window: ScrapeWindow): Map<string, SpielplanEntry> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, SpielplanEntry>();
  for (const row of html.split(/class="[^"]*vorstellung performance produktion-/).slice(1)) {
    const head = row.slice(0, 400);
    const sparten = new Set([...head.matchAll(/sparte-(\d+)/g)].map((m) => m[1]));
    if (![...sparten].some((s) => s && OPERA_SPARTE.has(s))) continue;
    const dm = head.match(/date-(\d{2})(\d{2})(\d{2})/);
    const slug = row.match(/produktionen\/([a-z0-9-]+)\.html\?ID_Vorstellung/)?.[1];
    if (!dm || !slug) continue;
    const date = `20${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
    if (window.since && date < window.since) continue;
    const tm = row.match(/(\d{1,2})\.(\d{2})\s*[–-]/);
    const time = tm ? `${tm[1]?.padStart(2, "0")}:${tm[2]}` : null;

    let entry = bySlug.get(slug);
    if (!entry) {
      entry = { perfs: [] };
      bySlug.set(slug, entry);
    }
    entry.perfs.push({ date, time, status: date < today ? "past" : "scheduled" });
  }
  return bySlug;
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  entry: SpielplanEntry,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/de/produktionen/${slug}.html`;
  const html = await fetchHtml(detailUrl, ctx);
  const workTitle = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!workTitle) return null;

  const { creative_team, cast } = parseBesetzung(html);
  const seen = new Set<string>();
  const performances = entry.perfs
    .filter((p) => {
      const k = `${p.date}|${p.time ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));

  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: parseComposer(html),
    detail_url: detailUrl,
    creative_team,
    cast,
    performances,
  };
}

/** "… Oper Musik von Giuseppe Verdi Libretto von …" near the title. */
function parseComposer(html: string): string | null {
  const m = stripHtml(html).match(
    /Musik von\s+([A-ZÄÖÜ][^,<]+?)(?:\s+Libretto|\s+nach|\s+Text|\s+Oper|\s+Operette|$)/,
  );
  return m?.[1]?.trim() || null;
}

/** Besetzung: `<div class="function_person"><span class="function">Label</span>
 *  <span class="person"><a>Name</a> / <a>Name</a></span></div>`. A mapped German
 *  function → creative team; a character-role label → sung cast. */
function parseBesetzung(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<div class="function_person">\s*<span class="function[^"]*">([^<]*)<\/span>\s*<span class="person[^"]*">([\s\S]*?)<\/span>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    if (!label) continue;
    const block = m[2] ?? "";
    const names = [...block.matchAll(/<a[^>]*>([^<]*)<\/a>/g)].map((x) => stripHtml(x[1] ?? ""));
    for (const name of names.length > 0 ? names : [stripHtml(block)]) {
      const key = `${label}|${name}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative_team.push(credit);
      else cast.push(credit);
    }
  }
  return { creative_team, cast };
}
