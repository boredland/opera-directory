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
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Theater Hof (`spielplan-html`, TYPO3, server-rendered, no proxy).
 *
 * /spielplan/stueckuebersicht lists the whole season as `div.stueck-item`; the
 * genre `<i>` in `h6.stueck-subheader` is the opera marker (keep exactly
 * "Oper"/"Operette"). Each `/spielplan/stuecke/detail/{slug}` page has the `<h1>`
 * title, an `infobox-author` "<i>{genre}</i> VON {Composer}", a `termine-grid`
 * (each `termin-item` carrying DD.MM.YYYY + HH:MM + venue — years are explicit)
 * and `info-ensemble` lists: `einteilung-1` = creative team (German labels),
 * `einteilung-0` = sung cast, `einteilung-2` = ensembles (skipped). Touring house —
 * venues vary. Future/season → Wikidata backfill.
 */

const BASE = "https://www.theater-hof.de";
/** Theater Hof on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415806";

export async function scrapeTheaterHof(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(`${BASE}/spielplan/stueckuebersicht`, ctx);
    for (const slug of operaSlugs(index)) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-hof: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-hof: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-hof: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-hof", productions };
}

/** One slug per `stueck-item` whose genre `<i>` is exactly Oper/Operette. */
function operaSlugs(html: string): string[] {
  const slugs = new Set<string>();
  for (const item of html.split('class="stueck-item"').slice(1)) {
    const genre = stripHtml(item.match(/stueck-subheader"[^>]*>\s*<p><i>([^<]*)<\/i>/)?.[1] ?? "");
    if (!/^oper(ette)?$/i.test(genre.trim())) continue;
    const slug = item.match(/href="\/spielplan\/stuecke\/detail\/([^"]+)"/)?.[1];
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/spielplan/stuecke/detail/${slug}`;
  const html = await fetchHtml(url, ctx);
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  // infobox-author is "<i>{genre}</i> VON {Composer}" — strip the leading "VON ".
  const author = stripHtml(
    html.match(/infobox-author"[^>]*>\s*<p>\s*<i>[^<]*<\/i>([\s\S]*?)<\/p>/)?.[1] ?? "",
  );
  // "VON {Composer}"; a double-bill appends "/ {next work's genre}" — keep the first.
  const composer =
    author
      .replace(/^\s*von\s+/i, "")
      .split(/\s+\/\s+/)[0]
      ?.trim() || null;
  if (!title || !composer) return null;

  const performances = parseTermine(html, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseEnsemble(html);
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

/** `termine-grid` rows: "DD.MM.YYYY, <span>HH:MM Uhr</span>" + a `.location` venue. */
function parseTermine(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const item of html.split('class="termin-item"').slice(1)) {
    const dm = item.match(/(\d{2})\.(\d{2})\.(\d{4}),?\s*<span>(\d{1,2}:\d{2})\s*Uhr/);
    if (!dm) continue;
    const date = `${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
    const time = dm[4] ?? null;
    if ((window.since && date < window.since) || seen.has(`${date}|${time}`)) continue;
    seen.add(`${date}|${time}`);
    performances.push({
      date,
      time,
      venue_room: stripHtml(item.match(/class="location">([^<]*)</)?.[1] ?? "") || null,
      status: date < today ? "past" : "scheduled",
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** `info-ensemble`: `einteilung-1` = creative (German labels), `einteilung-0` =
 *  sung cast (role → singer). Each `li.ensemble-rolle` is a `rolle-name` label + a
 *  name (linked `ensemble-name` or a trailing plain span). `einteilung-2` =
 *  chorus/orchestra ensembles, skipped. */
function parseEnsemble(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];

  for (const [, kind, seg] of html.matchAll(/einteilung-(\d)">([\s\S]*?)<\/ul>/g)) {
    if (kind !== "0" && kind !== "1") continue;
    for (const m of (seg ?? "").matchAll(
      /rolle-name">([\s\S]*?)<\/span>\s*(?:<a[^>]*>([\s\S]*?)<\/a>|<span[^>]*>([\s\S]*?)<\/span>)/g,
    )) {
      const label = stripHtml(m[1] ?? "");
      const name = stripHtml(m[2] ?? m[3] ?? "");
      if (!label || !name) continue;
      if (kind === "1") {
        const credit = normalizeGermanCredit(label, name);
        creative.push(credit.function ? credit : { function: label, name });
      } else {
        cast.push({ role: label, name });
      }
    }
  }
  return { cast, creative };
}
