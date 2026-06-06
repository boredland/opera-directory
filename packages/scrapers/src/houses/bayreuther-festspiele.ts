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
 * Bayreuther Festspiele — the Richard-Wagner opera festival on the Grüner Hügel
 * (`spielplan-html`, WordPress + WPBakery, no event JSON-LD).
 *
 * This is a FESTIVAL, not a year-round house: it publishes ONE edition at a time
 * (late July–August), plays a few summer weeks, then sits empty. So the live leg
 * only ever sees the CURRENT edition's programme (2026 at time of writing) and the
 * deep past/announced editions come from Wikidata backfill (Q157596).
 *
 * Live source: the Spielplan (`/programm/spielplan/`) is the authoritative dated
 * performance list — a flat `ul.fsdb__performances` of
 * `<li>… --datetime "Wochentag, DD. Monat YYYY, HH:MM Uhr" … <h2><a href="…/auffuehrungen/{slug}/">Title</a></h2>
 * <span class="fsdb__performances--info">venue note</span></li>` rows. Rows are
 * grouped by `{slug}` into one production each; the slug's detail page
 * (`/programm/auffuehrungen/{slug}/`) carries composer/cast/creative team.
 *
 * Opera gate: the festival's programme mixes staged operas with concerts, open-airs
 * and a children's matinee. A detail page is kept only when it has a "Besetzung 2026"
 * cast block AND a "Musikalische Leitung" — that uniquely flags a staged sung work
 * (all seven Wagner operas + the contemporary opera "Brünnhilde brennt") and drops
 * the IX. Symphonie concert, the Festspiel-Open-Air, the Chor-Open-Air and the
 * "venus, engel & die nacht" installation.
 *
 * Composer: the page rarely prints a work-type line, but a non-Wagner work tags its
 * composer with a "Komposition:" label ("Brünnhilde brennt" → Bernhard Lang). We
 * read that when present and otherwise default to Richard Wagner — safe here because
 * Bayreuth, by its founding charter, stages ONLY Wagner operas plus the occasional
 * commissioned companion piece (which carries the explicit Komposition label).
 */

const BASE = "https://www.bayreuther-festspiele.de";
const SPIELPLAN_URL = `${BASE}/programm/spielplan/`;
/**
 * The festival on Wikidata is Q157596 ("annual music festival of Wagner operas",
 * verified via wbsearchentities) — but that entity carries NO production relations.
 * The canonical Bayreuth world premieres (Ring 1876, Siegfried/Götterdämmerung
 * 1876, Parsifal 1882) are modeled with P4647 "location of first performance"
 * pointing at the Festspielhaus BUILDING Q329133, so backfill queries that QID —
 * that's where the production facts actually live (distinct again from the company
 * Q113045037, which has none).
 */
const WIKIDATA_QID = "Q329133";

const FESTSPIELHAUS = "Bayreuther Festspielhaus";

const MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  märz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

export async function scrapeBayreutherFestspiele(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const bySlug = await parseSpielplan(ctx, window);
    for (const [slug, performances] of bySlug) {
      try {
        const prod = await buildProduction(ctx, slug, performances);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`bayreuther-festspiele: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("bayreuther-festspiele: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("bayreuther-festspiele: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "bayreuther-festspiele", productions };
}

/** Group the flat Spielplan performance rows by their `auffuehrungen/{slug}`. */
async function parseSpielplan(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<Map<string, RawPerformance[]>> {
  const html = await fetchHtml(SPIELPLAN_URL, ctx);
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, RawPerformance[]>();

  const rowRe =
    /class="fsdb__performances--datetime">\s*([^<]*?)\s*<\/span>[\s\S]*?<a href="[^"]*\/auffuehrungen\/([a-z0-9-]+)\/?"[^>]*>[\s\S]*?class="fsdb__performances--info">\s*([^<]*?)\s*<\/span>/g;
  for (const [, rawDate, slug, rawInfo] of html.matchAll(rowRe)) {
    if (!slug) continue;
    const parsed = parseDateTime(rawDate ?? "");
    if (!parsed) continue;
    const { date, time } = parsed;
    if (window.since && date < window.since) continue;

    const venueNote = stripHtml(decodeEntities(rawInfo ?? ""));
    const perfs = bySlug.get(slug) ?? [];
    perfs.push({
      date,
      time,
      venue_room: venueNote || FESTSPIELHAUS,
      status: date < today ? "past" : "scheduled",
    });
    bySlug.set(slug, perfs);
  }

  for (const perfs of bySlug.values()) {
    perfs.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
  }
  return bySlug;
}

/** "Freitag, 24. Juli 2026, 20:00 Uhr" → { date, time }. */
function parseDateTime(text: string): { date: IsoDate; time: string | null } | null {
  const m = decodeEntities(text).match(
    /(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s*(\d{4})(?:,\s*(\d{1,2}:\d{2}))?/,
  );
  if (!m) return null;
  const [, dd, month, yyyy, time] = m;
  const mm = MONTHS[(month ?? "").toLowerCase()];
  if (!mm || !dd || !yyyy) return null;
  return {
    date: `${yyyy}-${mm}-${dd.padStart(2, "0")}` as IsoDate,
    time: time ?? null,
  };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  performances: RawPerformance[],
): Promise<RawProduction | null> {
  if (performances.length === 0) return null;
  const url = `${BASE}/programm/auffuehrungen/${slug}/`;
  const html = await fetchHtml(url, ctx);

  const castBlock = extractCastBlock(html);
  // The cast block ("Besetzung {year}" + a Musikalische Leitung line) is the
  // marker of a staged sung work — concerts/open-airs/installations lack it.
  if (!castBlock || !/musikalische leitung/i.test(castBlock)) return null;

  const rows = parseCreditRows(castBlock);
  const { cast, creative, composer, librettist } = classifyRows(rows);

  const title = cleanTitle(html, [composer, librettist]);
  if (!title) return null;

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer ?? "Richard Wagner",
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** Slice from "Besetzung {year}" to the next WPBakery text heading (usually "Termine"). */
function extractCastBlock(html: string): string | null {
  const start = html.search(/w-text-value">\s*Besetzung\s*\d{4}/i);
  if (start === -1) return null;
  const rest = html.slice(start + 20);
  const next = rest.search(/w-text-value">/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Each credit is a `<p><strong>Label:</strong> Name…</p>` row. Trailing prose
 *  paragraphs (no `<strong>` label, or a sentence) are dropped by the caller. */
function parseCreditRows(block: string): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  for (const [, label, value] of block.matchAll(
    /<p>\s*<strong>\s*([^<:]+?):?\s*<\/strong>\s*([\s\S]*?)<\/p>/g,
  )) {
    const l = stripHtml(decodeEntities(label ?? ""));
    const v = stripHtml(decodeEntities(value ?? ""));
    if (l && v) rows.push({ label: l, value: v });
  }
  return rows;
}

/** Pull out an explicit composer (the "Komposition:" label, present only for
 *  non-Wagner commissions) and librettist; split the rest into creative vs. cast. */
function classifyRows(rows: { label: string; value: string }[]): {
  cast: RawCredit[];
  creative: RawCredit[];
  composer: string | null;
  librettist: string | null;
} {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  let composer: string | null = null;
  let librettist: string | null = null;

  for (const { label, value } of rows) {
    if (/^komposition$/i.test(label)) {
      composer = firstName(value);
      continue;
    }
    if (/^libretto$/i.test(label)) {
      librettist = firstName(value);
      continue;
    }

    const credit = normalizeGermanCredit(label, "");
    // A label that maps to a creative function → creative team; anything else is
    // a sung role. Casting splits across names with per-night date tags; emit each.
    if (credit.function) {
      for (const name of splitNames(value)) creative.push({ function: credit.function, name });
    } else {
      for (const name of splitNames(value)) cast.push({ role: label, name });
    }
  }
  return { cast, creative, composer, librettist };
}

/** "Magnus Vigilius (14.08.), Andreas Schager (26.07., 03.08.)" → both singers,
 *  date tags stripped. The casting commas inside a "(…)" tag must not split. */
function splitNames(value: string): string[] {
  const names: string[] = [];
  for (const part of value.split(/,(?![^(]*\))/)) {
    const name = part
      .replace(/\([^)]*\)/g, "")
      .replace(/^Ks\.\s+/i, "") // "Kammersänger" honorific
      .trim();
    if (name) names.push(name);
  }
  return names;
}

function firstName(value: string): string | null {
  return splitNames(value)[0] ?? null;
}

/** H1 is the work title; for a non-Wagner commission it is prefixed with the
 *  authors ("Bernhard Lang/Michael Sturminger Brünnhilde Brennt: …") — strip the
 *  known author names off the front, then drop any ": subtitle" tail. */
function cleanTitle(html: string, authors: (string | null)[]): string | null {
  const raw = stripHtml(decodeEntities(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? ""));
  if (!raw) return null;
  let title = raw;
  for (const author of authors) {
    if (!author) continue;
    const idx = title.indexOf(author);
    if (idx !== -1) title = title.slice(idx + author.length);
  }
  title = title
    .replace(/^[\s/]+/, "")
    .replace(/:.*$/, "")
    .trim();
  return title || raw;
}
