import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, proxyFetch, stripHtml } from "../fetch";
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
 * Stadttheater Klagenfurt (`spielplan-html` strategy, German-language, WordPress).
 *
 * Carinthia's multi-genre house — opera/operetta share the stage ("Bühne") with
 * Schauspiel, ballet, musical and concerts. The site is server-rendered WordPress
 * (no schema.org Event JSON-LD, no public REST custom post type); productions live
 * at `/produktionen/{slug}/`, listed on `/produktionen/`. The current season's
 * "Bühne" cards are inline in that page; other seasons load through the theme's
 * `productionoverviewfilter` admin-ajax action (one term id per Spielzeit, newest
 * first), which returns a JSON `{output: html}` whose HTML is the same card markup
 * grouped under genre anchors (`<div class="o-anchor" id="buehne">` …). We only
 * follow the "Bühne" section — concerts, workshops, talks and the children's
 * programme live under other anchors and are never opera.
 *
 * GENRE FILTER (the opera gate). Each detail page carries a
 * `c-production-detail__subtitle` that is both the genre line and the composer
 * source, e.g. "Oper in drei Akten von Christoph Willibald Gluck", "Melodramma …
 * von Giacomo Puccini", "Handlung in drei Aufzügen von Richard Wagner". The house
 * doesn't reliably print "Oper" (Wagner reads "Handlung in … Aufzügen"; the
 * Offenbach operetta gives only "von Jacques Offenbach"), so the gate is the
 * inverse of wiener-volksoper's: keep iff a composer is parseable
 * (`composerFromText`) AND the subtitle does NOT name a non-opera format
 * (Schauspiel/Ballett/Musical/musikalische Komödie/Kriminalkomödie/Konzert/Gala/
 * Liederabend/workshop/Führung/Probe/Gespräch). That keeps opera + operetta and
 * drops the rest.
 *
 * Dates are server-rendered on the detail page as
 * `c-production-date-tickets__entry-meta` lines "Di, 09.06.2026, 19:30" (a finished
 * production drops its dates entirely — "Keine Termine vorhanden" — so past-season
 * productions yield composer + cast but empty performances; the deep past comes
 * from the Wikidata backfill). Cast/creative is the `c-production-cast__entry`
 * list: an uppercase `__entry-assignment` label (German credit map → creative
 * function, else a sung role) plus one or more `__entry-person` names, each maybe
 * tagged with the dates it applies to ("Mitsugu Hoshino (23.11.2024)") — trimmed.
 */

const BASE = "https://www.stadttheater-klagenfurt.at";
const AJAX = `${BASE}/wp-admin/admin-ajax.php`;

/** Stadttheater Klagenfurt on Wikidata — Q872374 ("Stadttheater Klagenfurt",
 *  instance-of theatre building + opera house). Verified via wbsearchentities and
 *  by SPARQL: it carries a labelled production (Cherubini's *Koukourgi*, premiere
 *  2010-09-16) via P4647, whereas the separate "theatre company" record
 *  Q113470582 carries only an unlabelled item — so the building QID is the one
 *  with usable backfill data (the same building-vs-company split as Volksoper). */
const WIKIDATA_QID = "Q872374";

/** The overview season `<select>` lists term ids back to ~2012/13. Cap the backfill
 *  walk generously; older terms 404/empty and are skipped. */
const MAX_BACKFILL_SEASONS = 40;

export async function scrapeStadttheaterKlagenfurt(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const overview = await fetchHtml(`${BASE}/produktionen/`, ctx);
    const nonce = overview.match(
      /c-productions-overview[\s\S]{0,1500}?data-nonce="([0-9a-f]+)"/,
    )?.[1];
    const seasons = parseSeasons(overview);

    const slugs = new Set<string>();
    for (const slug of buehneSlugs(overview)) slugs.add(slug);

    for (const slug of await collectSeasonSlugs(ctx, window, nonce, seasons)) slugs.add(slug);

    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`stadttheater-klagenfurt: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("stadttheater-klagenfurt: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("stadttheater-klagenfurt: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "stadttheater-klagenfurt", productions };
}

/** Season `<select>` options: [term id, "YYYY/YY"] newest-first. */
function parseSeasons(html: string): { id: string; label: string }[] {
  const seasons: { id: string; label: string }[] = [];
  for (const [, id, label] of matchAllPair(
    html,
    /data-filter="(\d+)"[\s\S]{0,160}?o-select__item-link">Spielzeit\s*(\d{4}\/\d{2})/g,
  )) {
    seasons.push({ id, label });
  }
  return seasons;
}

/**
 * Which seasons to load beyond the inline current one. Backfill walks every season
 * term back to `window.since` (a "YYYY/YY" label ending before `since`'s year is
 * past the cutoff); incremental loads only the next announced season (so the
 * future leg sees a season the moment it's published).
 */
async function collectSeasonSlugs(
  ctx: FetchContext,
  window: ScrapeWindow,
  nonce: string | undefined,
  seasons: { id: string; label: string }[],
): Promise<string[]> {
  if (!nonce) return [];
  const sinceYear = window.since ? Number.parseInt(window.since.slice(0, 4), 10) : null;
  const slugs: string[] = [];

  let walked = 0;
  for (const season of seasons) {
    if (window.mode !== "backfill") {
      // Incremental: only the future season(s) — those whose end year is >= this year.
      const endYear = 2000 + Number.parseInt(season.label.slice(5), 10);
      if (endYear < new Date().getFullYear()) continue;
    } else {
      if (walked++ >= MAX_BACKFILL_SEASONS) break;
      if (sinceYear) {
        const endYear = 2000 + Number.parseInt(season.label.slice(5), 10);
        if (endYear < sinceYear) break;
      }
    }
    try {
      const html = await fetchSeasonOverview(ctx, nonce, season.id);
      if (html) slugs.push(...buehneSlugs(html));
    } catch (err) {
      console.warn(`stadttheater-klagenfurt: season ${season.label} failed:`, err);
    }
  }
  return slugs;
}

/** POST the `productionoverviewfilter` admin-ajax action and unwrap its JSON
 *  `{output: html}`. The theme posts the season id as `season_id`; the response
 *  HTML carries the same genre-grouped card markup as the SSR overview. */
async function fetchSeasonOverview(
  ctx: FetchContext,
  nonce: string,
  seasonId: string,
): Promise<string | null> {
  const body = new URLSearchParams({
    action: "productionoverviewfilter",
    nonce,
    season_id: seasonId,
  }).toString();
  const res = await proxyFetch(AJAX, ctx.proxy, {
    method: "POST",
    headers: {
      "User-Agent": ctx.userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { output?: string };
  return data.output ?? null;
}

/** Production slugs under the "Bühne" genre anchor only (opera/operetta/ballet/
 *  musical/Schauspiel share it; later gated by composer). Concerts, workshops,
 *  talks and the children's programme sit under other anchors and are skipped. */
function buehneSlugs(html: string): string[] {
  const anchorRe = /<div class="o-anchor" id="([a-z0-9-]+)"/g;
  const anchors = [...html.matchAll(anchorRe)].map((m) => ({ at: m.index ?? 0, id: m[1] }));
  const buehne = anchors.find((a) => a.id === "buehne");
  if (!buehne) return [];
  const next = anchors.find((a) => a.at > buehne.at);
  const section = html.slice(buehne.at, next ? next.at : undefined);

  const slugs = new Set<string>();
  for (const m of section.matchAll(/\/produktionen\/([a-z0-9-]+)\//g)) {
    if (m[1]) slugs.add(m[1]);
  }
  return [...slugs];
}

/** Non-opera formats the subtitle names; their presence drops the production. */
const NON_OPERA_RE =
  /\b(schauspiel|ballett(abend)?|tanz(abend|theater)?|musical|musikalische kom[öo]die|kriminalkom[öo]die|kom[öo]die|kabarett|lesung|liederabend|konzert|gala(konzert|abend)?|matinee|workshop|f[üu]hrung|probe(nbesuch)?|gespr[äa]ch|diskussion|backstage|spielplan|pr[äa]sentation)\b/i;

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/produktionen/${slug}/`;
  const html = await fetchHtml(url, ctx);

  const subtitle = stripHtml(
    html.match(/c-production-detail__subtitle">([\s\S]*?)<\/h4>/)?.[1] ?? "",
  );
  if (!subtitle || NON_OPERA_RE.test(subtitle)) return null;
  const composer = composerFromText(subtitle);
  if (!composer) return null;

  // The <h1> holds a nested social-share <div> after the title text, so grab only
  // the leading text node (up to the first tag), not the whole element.
  const title = stripHtml(html.match(/c-production-detail__title">([^<]*)/)?.[1] ?? "");
  if (!title) return null;

  const performances = parseDates(html, window);
  const { cast, creative_team } = parseCast(html);

  return {
    source_production_id: `stadttheater-klagenfurt/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team,
    cast,
    performances,
  };
}

/** `c-production-date-tickets__entry-meta` lines "Di, 09.06.2026, 19:30" → dated
 *  performances. A finished production prints "Keine Termine vorhanden." (no
 *  lines), so the array is legitimately empty for past-season productions. */
function parseDates(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const [, raw] of matchAllSingleGroup(
    html,
    /c-production-date-tickets__entry-meta">([\s\S]*?)<\/div>/g,
  )) {
    const m = stripHtml(raw).match(/(\d{2})\.(\d{2})\.(\d{4})(?:,?\s*(\d{1,2}:\d{2}))?/);
    if (!m) continue;
    const date = `${m[3]}-${m[2]}-${m[1]}` as IsoDate;
    const time = m[4] ? m[4].padStart(5, "0") : null;
    if ((window.since && date < window.since) || seen.has(`${date}|${time}`)) continue;
    seen.add(`${date}|${time}`);
    performances.push({ date, time, status: date < today ? "past" : "scheduled" });
  }

  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

const CAST_ENTRY_RE =
  /c-production-cast__entry-assignment">([\s\S]*?)<\/div>([\s\S]*?)(?=c-production-cast__entry-assignment"|c-production-cast__entries)/g;
const PERSON_RE = /js-production-cast__entry-person-inner">\s*([\s\S]*?)\s*<\/a>/g;

/**
 * Cast + creative team from the `c-production-cast__entry` blocks: an uppercase
 * `__entry-assignment` label that the German credit map knows is a creative
 * function ("Musikalische Leitung" → conductor); the rest are sung roles. Each
 * person name may carry a trailing date qualifier ("(23.11.2024)") marking which
 * nights it applies to — trimmed. Deduped.
 */
function parseCast(html: string): { cast: RawCredit[]; creative_team: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative_team: RawCredit[] = [];
  const seenCast = new Set<string>();
  const seenCreative = new Set<string>();

  for (const [, rawLabel, block] of matchAllPair(html, CAST_ENTRY_RE)) {
    const label = stripHtml(rawLabel);
    if (!label) continue;
    for (const [, rawName] of matchAllSingleGroup(block, PERSON_RE)) {
      const name = stripHtml(rawName)
        .replace(/\s*\([^)]*\)\s*$/, "")
        .trim();
      if (!name) continue;

      const credit = normalizeGermanCredit(label, name);
      if (credit.function) {
        const key = `${credit.function}|${name}`;
        if (seenCreative.has(key)) continue;
        seenCreative.add(key);
        creative_team.push(credit);
      } else {
        const key = `${label}|${name}`;
        if (seenCast.has(key)) continue;
        seenCast.add(key);
        cast.push({ role: label, name: decodeEntities(name) });
      }
    }
  }

  return { cast, creative_team };
}

/** matchAll wrapper yielding [full, g1] tuples — keeps adapters regex-only, no eval. */
function* matchAllSingleGroup(html: string, re: RegExp): Generator<[string, string]> {
  for (const m of html.matchAll(re)) yield [m[0], m[1] ?? ""];
}

/** matchAll wrapper yielding [full, g1, g2] tuples. */
function* matchAllPair(html: string, re: RegExp): Generator<[string, string, string]> {
  for (const m of html.matchAll(re)) yield [m[0], m[1] ?? "", m[2] ?? ""];
}
