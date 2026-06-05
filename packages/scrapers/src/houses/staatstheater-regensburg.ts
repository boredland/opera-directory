import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawCredit, RawProduction, ScrapeWindow } from "../types";
import { walkSpielplanCalendar } from "./_calendar-cms";
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Theater Regensburg (`spielplan-html` strategy, flat-file calendar CMS).
 *
 * Shares the `_calendar-cms` walker with Theater Aachen: the spielplan months come
 * from `spielplan/musiktheater.html?ajax=1&offset={n}`, where every performance row
 * carries `date-{DDMMYY}` + `sparte-{n}` (18 = Musiktheater here) + a
 * `produktionen/{slug}.html` link + "HH.MM Uhr". Each server-rendered detail page
 * gives the title (`<h1>`), composer ("Musik von …") and the Besetzung
 * (`text-uppercase` function/role label + `personen/…` name links). Future-only →
 * Wikidata backfill. The house rebranded to staatstheater-regensburg.de
 * (theaterregensburg.de 301-redirects there).
 */

const BASE = "https://www.staatstheater-regensburg.de";
/** Theater Regensburg on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1609618";
/** sparte- class id for Musiktheater (opera/operetta) vs. Schauspiel/Tanz/Konzert. */
const OPERA_SPARTEN = new Set(["18"]);

export async function scrapeStaatstheaterRegensburg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  const bySlug = await walkSpielplanCalendar(
    ctx,
    {
      ajaxUrl: (offset) => `${BASE}/spielplan/musiktheater.html?ajax=1&offset=${offset}`,
      operaSparten: OPERA_SPARTEN,
    },
    window,
  );
  for (const [slug, perfs] of bySlug) {
    try {
      const prod = await buildProduction(ctx, slug, perfs);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`staatstheater-regensburg: ${slug} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatstheater-regensburg: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatstheater-regensburg", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  perfs: RawProduction["performances"],
): Promise<RawProduction | null> {
  if (perfs.length === 0) return null;
  const detailUrl = `${BASE}/produktionen/${slug}.html`;
  const html = await fetchHtml(detailUrl, ctx);
  const workTitle = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!workTitle) return null;

  const composer = composerFromText(stripHtml(html.match(/Musik von[\s\S]{0,160}/)?.[0] ?? ""));
  const { creative_team, cast } = parseBesetzung(html);

  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: composer,
    detail_url: detailUrl,
    creative_team,
    cast,
    performances: perfs,
  };
}

/** Besetzung rows: `<span class="text-uppercase">Label</span></div> <div…> <a
 *  href="personen/…">Name</a> [/ Name] </div>`. A mapped German function → creative
 *  team; a character-role label → sung cast. Scoped after the "Besetzung" heading
 *  so the page's `text-uppercase` Sparte label isn't mistaken for a credit. */
function parseBesetzung(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const start = html.indexOf(">Besetzung<");
  if (start < 0) return { creative_team, cast };
  const section = html.slice(start);
  const seen = new Set<string>();
  for (const m of section.matchAll(
    /<span class="text-uppercase">([^<]+)<\/span>\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    if (!label) continue;
    const block = m[2] ?? "";
    const raw = [...block.matchAll(/<a[^>]*>([^<]*)<\/a>/g)].map((x) => stripHtml(x[1] ?? ""));
    const names = (raw.length > 0 ? raw : [stripHtml(block)]).flatMap((n) => n.split(/\s*\/\s*/));
    for (const name of names) {
      if (!name || name === "N.N." || seen.has(`${label}|${name}`)) continue;
      seen.add(`${label}|${name}`);
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative_team.push(credit);
      else cast.push(credit);
    }
  }
  return { creative_team, cast };
}
