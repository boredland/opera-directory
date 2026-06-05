import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawCredit, RawProduction, ScrapeWindow } from "../types";
import { walkSpielplanCalendar } from "./_calendar-cms";
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Theater Aachen (`spielplan-html` strategy, flat-file calendar CMS).
 *
 * Shares the `_calendar-cms` walker with Theater Regensburg: months come from
 * `de/spielplan/musiktheater.html?ajax=1&offset={n}`, every performance row
 * carrying `date-{DDMMYY}` + `sparte-{n}` (4 = Musiktheater here) + a
 * `produktionen/{slug}.html` link + "HH:MM Uhr". Each server-rendered detail page
 * gives the title (`<h1>`), composer (the "… von {Composer}" subtitle after the
 * title) and the Besetzung (`fw-semibold` function/role label + `personen/…` name
 * links). Future-only → Wikidata backfill.
 */

const BASE = "https://www.theateraachen.de";
/** Theater Aachen on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q118434104";
/** sparte- class id for Musiktheater (opera) vs. Schauspiel/Tanz/Konzert. */
const OPERA_SPARTEN = new Set(["4"]);

export async function scrapeTheaterAachen(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  const bySlug = await walkSpielplanCalendar(
    ctx,
    {
      ajaxUrl: (offset) => `${BASE}/de/spielplan/musiktheater.html?ajax=1&offset=${offset}`,
      operaSparten: OPERA_SPARTEN,
    },
    window,
  );
  for (const [slug, perfs] of bySlug) {
    try {
      const prod = await buildProduction(ctx, slug, perfs);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`theater-aachen: ${slug} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-aachen: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-aachen", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  perfs: RawProduction["performances"],
): Promise<RawProduction | null> {
  if (perfs.length === 0) return null;
  const detailUrl = `${BASE}/de/produktionen/${slug}.html`;
  const html = await fetchHtml(detailUrl, ctx);
  const workTitle = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!workTitle) return null;

  const subtitle = stripHtml(html.match(/<\/h1>([\s\S]{0,300})/)?.[1] ?? "");
  const { creative_team, cast } = parseBesetzung(html);

  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: composerFromText(subtitle),
    detail_url: detailUrl,
    creative_team,
    cast,
    performances: perfs,
  };
}

/** Besetzung rows: `<span class="fw-semibold">Label</span> <a href="personen/…">
 *  Name</a>…`, one label followed by its name links until the next label. A mapped
 *  German function → creative team; a character-role label → sung cast. Scoped from
 *  the "Besetzung" heading to the following "Termine" heading. */
function parseBesetzung(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const start = html.indexOf(">Besetzung<");
  if (start < 0) return { creative_team, cast };
  const end = html.indexOf("<h2", start + 10);
  const section = html.slice(start, end > start ? end : start + 6000);

  const seen = new Set<string>();
  const parts = section.split(/<span class="fw-semibold">/).slice(1);
  for (const part of parts) {
    const label = stripHtml(part.match(/^([^<]+)<\/span>/)?.[1] ?? "");
    if (!label) continue;
    const names = [...part.matchAll(/href="personen\/[^"]*"[^>]*>([^<]+)<\/a>/g)].map((x) =>
      stripHtml(x[1] ?? ""),
    );
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
