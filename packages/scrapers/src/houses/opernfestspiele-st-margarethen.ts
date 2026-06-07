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
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Opernfestspiele St. Margarethen — "Oper im Steinbruch", Burgenland/Austria
 * (`spielplan-html`, FESTIVAL).
 *
 * Open-air opera in the Roman quarry (Römersteinbruch St. Margarethen): one big
 * staged opera each summer (~mid-July to late August), the site advertising only
 * the CURRENT edition — a live scrape sees one production. Past editions come
 * from Wikidata backfill.
 *
 * The home page hero carries the edition: `<h1>{WORK}</h1>` +
 * `<p class="production-author">{Composer}</p>` + a `/spielplan-{year}` link, and
 * also links the matching `/besetzung-{year}` (cast) and `/leading-team-{year}`
 * (creative team) pages — all discovered from the home page so the adapter
 * survives the yearly slug rollover. Dates ride in the spielplan page as event
 * sections classed `termin-{ISO date}` with a `<p class="time">20:00 Uhr</p>`;
 * the festival is a single opera, so every date is one production. Cast and
 * creative team are `<p class="cast-role">Label</p><p class="cast-name">Name</p>`
 * pairs — the leading-team labels are German function labels (Musikalische
 * Leitung, Regie und Bühnenbild, Kostüme → creative via normalizeGermanCredit;
 * unmapped ones like "Live Action Director" fall back verbatim), the besetzung
 * labels are sung roles (Tosca, Cavaradossi → cast).
 *
 * Opera gate: a production is emitted only when the hero yields both a work title
 * and a composer.
 */

const BASE = "https://www.operimsteinbruch.at";
/** Oper im Steinbruch St. Margarethen on Wikidata — Q2026658 ("sommerliches
 *  Opernfestival"), verified via wbsearchentities. It carries no P4647/P272
 *  production relations today, so backfill currently yields nothing there; the
 *  QID rides along for when those facts get modelled. */
const WIKIDATA_QID = "Q2026658";

const VENUE = "Römersteinbruch St. Margarethen";

export async function scrapeOpernfestspieleStMargarethen(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const prod = await buildProduction(ctx, window);
    if (prod) productions.push(prod);
  } catch (err) {
    console.warn("opernfestspiele-st-margarethen: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opernfestspiele-st-margarethen: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "opernfestspiele-st-margarethen", productions };
}

async function buildProduction(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const home = await fetchHtml(`${BASE}/`, ctx);

  const hero = home.match(
    /<h1[^>]*>([\s\S]*?)<\/h1>\s*<p class="production-author">([\s\S]*?)<\/p>/,
  );
  const title = stripHtml(hero?.[1] ?? "");
  const composer = stripHtml(hero?.[2] ?? "") || null;
  if (!title || !composer) return null;

  const performances = await parsePerformances(ctx, home, window);
  if (performances.length === 0) return null;

  const cast = await parsePairs(ctx, home, "besetzung", true);
  const creative = await parsePairs(ctx, home, "leading-team", false);

  return {
    source_production_id: `oper-im-steinbruch:${seasonYear(performances) ?? title}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/`,
    creative_team: creative,
    cast,
    performances,
  };
}

/** Event sections on the `/spielplan-{year}` page: one per date, classed
 *  `termin-{ISO date}` with a sibling `<p class="time">HH:MM Uhr</p>`. */
async function parsePerformances(
  ctx: FetchContext,
  home: string,
  window: ScrapeWindow,
): Promise<RawPerformance[]> {
  const url = siblingUrl(home, "spielplan");
  if (!url) return [];
  const html = await fetchHtml(url, ctx);

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const [, date, rawTime] of html.matchAll(
    /class="termin-(\d{4}-\d{2}-\d{2})[^"]*"[\s\S]*?<p class="time">([^<]*)<\/p>/g,
  )) {
    const iso = date as IsoDate;
    if ((window.since && iso < window.since) || seen.has(iso)) continue;
    seen.add(iso);
    const tm = rawTime?.match(/(\d{1,2}):(\d{2})/);
    performances.push({
      date: iso,
      time: tm ? `${tm[1]?.padStart(2, "0")}:${tm[2]}` : null,
      venue_room: VENUE,
      status: iso < today ? "past" : "scheduled",
    });
  }

  performances.sort((a, b) => a.date.localeCompare(b.date));
  return performances;
}

/** `<p class="cast-role">Label</p><p class="cast-name">Name</p>` pairs on the
 *  `/besetzung-{year}` (sung roles) or `/leading-team-{year}` (creative) page.
 *  When `asRole` is false a mapped German function label → creative team, an
 *  unmapped one falls back verbatim; when true, every label is a sung role. */
async function parsePairs(
  ctx: FetchContext,
  home: string,
  kind: "besetzung" | "leading-team",
  asRole: boolean,
): Promise<RawCredit[]> {
  const url = siblingUrl(home, kind);
  if (!url) return [];
  let html: string;
  try {
    html = await fetchHtml(url, ctx);
  } catch (err) {
    console.warn(`opernfestspiele-st-margarethen: ${kind} fetch failed:`, err);
    return [];
  }

  const credits: RawCredit[] = [];
  const seen = new Set<string>();
  for (const [, rawLabel, rawName] of html.matchAll(
    /<p class="cast-role">([\s\S]*?)<\/p>\s*<p class="cast-name">([\s\S]*?)<\/p>/g,
  )) {
    const label = stripHtml(rawLabel ?? "");
    const name = stripHtml(rawName ?? "");
    if (!label || !name) continue;
    const credit = asRole ? { role: label, name } : normalizeGermanCredit(label, name);
    const key = `${credit.function ?? credit.role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    credits.push(credit);
  }
  return credits;
}

/** The `/{kind}-{year}` URL the home page links (e.g. `/spielplan-2026`). */
function siblingUrl(home: string, kind: string): string | null {
  const m = home.match(new RegExp(`href="(https://www\\.operimsteinbruch\\.at/${kind}-\\d{4})"`));
  return m?.[1] ? decodeEntities(m[1]) : null;
}

/** The edition year (the dominant calendar year across the run). */
function seasonYear(performances: RawPerformance[]): string | null {
  return performances[0]?.date.slice(0, 4) ?? null;
}
