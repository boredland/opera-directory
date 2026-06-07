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
 * Salzburger Landestheater (`spielplan-html` strategy) — the Salzburg city
 * theatre (Oper/Operette/Schauspiel/Musical/Ballett/Junges Land), NOT the
 * Salzburger Festspiele.
 *
 * German-language SSR HTML on a bespoke TYPO3-style CMS: no schema.org Event
 * JSON-LD and no public JSON API. The discovery surface is the per-season
 * programme index `/de/programm/index-{from}-{to}.html`, which renders one card
 * per production wrapping the detail URL `/de/produktionen/{slug}.html`.
 *
 * GENRE FILTER (the opera gate). The house is multi-genre; we keep only opera.
 * The current/upcoming programme cards carry a `sparte-30` CSS class on the Oper
 * division (verified across the 2025/26 and 2026/27 seasons — exactly the operas
 * carry it; Schauspiel is `sparte-2`, Ballett `sparte-4`, Musical `sparte-29`,
 * Junges Land `sparte-18`), so the gate is a cheap class check on the index plus
 * the composer requirement on the detail page (REQUIRE a composer = opera gate),
 * which drops the operatically-filed but spoken children's pieces.
 *
 * Discovery: the season index for the current and next season (the announced
 * future). Older season indexes drop the `sparte-*` class and the detail markup
 * is inconsistent, so deep history rides on the Wikidata backfill rather than a
 * fragile archive walk.
 *
 * Per detail page: `.titles` holds `<h2>{composer}</h2>` then the form/genre
 * `<p>` lines; the credit/cast block is `<p><span class="function">{label}</span>
 * <span class="person">{name…}</span></p>` pairs (a label the German credit map
 * knows is a creative function, the rest are sung roles); performances live in
 * `.terminlist` as `<span class="day">DD.MM.YYYY</span>` + `<span class="time">`.
 */

const BASE = "https://www.salzburger-landestheater.at";

/** Salzburger Landestheater on Wikidata — Q113470544 ("Salzburger Landestheater",
 *  "theatre company in Salzburg, Austria"). Verified via wbsearchentities (the
 *  other hit, Q1691028, is the building) AND by SPARQL: the company record is the
 *  superset (2 items via P4647/P272 vs the building's 1), and P272 production
 *  company is the semantically correct relation for stagings. Backfill is thin —
 *  typical for a non-marquee house — so it is resolution anchors, not a dataset. */
const WIKIDATA_QID = "Q113470544";

/** The Oper division's CSS class on the programme-index production cards. */
const OPER_SPARTE_RE = /\bsparte-30\b/;

interface IndexCard {
  slug: string;
  sparte: string;
}

export async function scrapeSalzburgerLandestheater(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const slugs = await collectOperaSlugs(ctx);
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(slug, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`salzburger-landestheater: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("salzburger-landestheater: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("salzburger-landestheater: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "salzburger-landestheater", productions };
}

/**
 * Gather the opera (`sparte-30`) production slugs from the current and next
 * season programme indexes — the announced future. Deduped across seasons.
 */
async function collectOperaSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  for (const season of currentAndNextSeasons()) {
    let html: string;
    try {
      html = await fetchHtml(`${BASE}/de/programm/index-${season}.html`, ctx);
    } catch (err) {
      console.warn(`salzburger-landestheater: season ${season} index failed:`, err);
      continue;
    }
    for (const card of parseIndexCards(html)) {
      if (OPER_SPARTE_RE.test(card.sparte)) slugs.add(card.slug);
    }
  }
  return [...slugs];
}

/** German opera seasons run Aug–Jul; before August the "current" season started
 *  the prior year. Returns the current + next season as `{from}-{to}` slugs. */
function currentAndNextSeasons(): string[] {
  const now = new Date();
  const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return [startYear, startYear + 1].map((y) => `${y}-${y + 1}`);
}

const CARD_RE = /class="item[^"]*"[^>]*>\s*<a href="\.\/produktionen\/([a-z0-9-]+)\.html/g;

/** Parse the programme-index production cards: their slug + the card's class
 *  list (which carries the `sparte-*` division code). */
function parseIndexCards(html: string): IndexCard[] {
  const cards: IndexCard[] = [];
  for (const [full, slug] of matchAllPair(html, CARD_RE)) {
    const classMatch = full.match(/class="(item[^"]*)"/);
    if (slug) cards.push({ slug, sparte: classMatch?.[1] ?? "" });
  }
  return cards;
}

/** Build a production from its detail page; null if no composer (opera gate) or
 *  no performance survives the window. */
async function buildProduction(
  slug: string,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/de/produktionen/${slug}.html`;
  const html = await fetchHtml(detailUrl, ctx);

  const title = parseTitle(html);
  if (!title) return null;

  const composer = parseComposer(html);
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `salzburger-landestheater/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: detailUrl,
    creative_team,
    cast,
    performances,
  };
}

function parseTitle(html: string): string | null {
  const m = html.match(/<h1>([\s\S]*?)<\/h1>/);
  const title = m?.[1] ? stripHtml(m[1]) : "";
  return title || null;
}

/**
 * Composer from the `.titles` block. The current markup puts a clean name in the
 * `<h2>` ("Wolfgang Amadeus Mozart"); older pages prefix the form ("Opera Buffa
 * von Gioachino Rossini"). When the `<h2>` reads as a "{form} von {Name}" line we
 * run `composerFromText`, else take the `<h2>` verbatim. As a fallback we scan
 * the form `<p>` lines (e.g. "… Musik von …").
 */
function parseComposer(html: string): string | null {
  const block = html.match(/class="titles">([\s\S]*?)<\/div>/)?.[1];
  if (!block) return null;

  const h2 = block.match(/<h2>([\s\S]*?)<\/h2>/)?.[1];
  if (h2) {
    const text = stripHtml(h2);
    if (/\bvon\b|\bMusik\b/i.test(text)) {
      const parsed = composerFromText(text);
      if (parsed) return parsed;
    } else if (text && text.length <= 60 && !/[.:]/.test(text)) {
      return text;
    }
  }

  for (const [, para] of matchAllPair(block, /<p>([\s\S]*?)<\/p>/g)) {
    const parsed = composerFromText(stripHtml(para));
    if (parsed) return parsed;
  }
  return null;
}

const TERMIN_RE =
  /<span class="day">(\d{2})\.(\d{2})\.(\d{4})<\/span>\s*<span class="time">(\d{1,2})[.:](\d{2})<\/span>/g;

/** Performances from the `.terminlist`. Status is derived from the date (the page
 *  marks past/unbookable dates `inactive`, but date-vs-today is the robust signal);
 *  no per-night venue or cancellation is published. Honours `window.since`. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const list = html.match(/class="terminlist">([\s\S]*?)<\/div>/)?.[1] ?? "";
  for (const [, dd, mm, yyyy, hh, min] of matchAllTermin(list, TERMIN_RE)) {
    const date = `${yyyy}-${mm}-${dd}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = `${hh.padStart(2, "0")}:${min}`;
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, status: date < today ? "past" : "scheduled" });
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

const CREDIT_PAIR_RE =
  /<span class="function">([\s\S]*?)<\/span>\s*<span class="person">([\s\S]*?)<\/span>/g;

/**
 * Cast + creative team from the `<span class="function">{label}</span>
 * <span class="person">{name…}</span>` pairs. A label the German credit map knows
 * is a creative function ("Musikalische Leitung" → conductor); the rest are sung
 * roles (verbatim fallback). The person span may list several `<a>` names (cast
 * alternations) each optionally followed by a "(date, date)" annotation we strip;
 * each name becomes its own credit. Deduped.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, rawLabel, rawPerson] of matchAllTwo(html, CREDIT_PAIR_RE)) {
    const label = stripHtml(rawLabel);
    if (!label) continue;

    for (const name of personNames(rawPerson)) {
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
        cast.push({ role: label, name });
      }
    }
  }

  return { creative_team, cast };
}

/** Split a person span into individual names: each name is an `<a>` (or the bare
 *  text when no link), with any trailing "(date list)" date annotation dropped. */
function personNames(rawPerson: string): string[] {
  const names: string[] = [];
  const anchorRe = /<a\b[^>]*>([\s\S]*?)<\/a>/g;
  let any = false;
  for (const [, inner] of matchAllPair(rawPerson, anchorRe)) {
    any = true;
    const name = cleanName(inner);
    if (name) names.push(name);
  }
  if (!any) {
    const name = cleanName(rawPerson);
    if (name) names.push(name);
  }
  return names;
}

function cleanName(raw: string): string {
  return stripHtml(decodeEntities(raw))
    .replace(/\([^)]*\)/g, "")
    .trim();
}

/** matchAll wrapper yielding [full, g1] tuples — keeps adapters regex-only, no eval. */
function* matchAllPair(text: string, re: RegExp): Generator<[string, string]> {
  for (const m of text.matchAll(re)) yield [m[0], m[1] ?? ""];
}

/** matchAll wrapper yielding [full, g1, g2] tuples for the credit-pair regex. */
function* matchAllTwo(text: string, re: RegExp): Generator<[string, string, string]> {
  for (const m of text.matchAll(re)) yield [m[0], m[1] ?? "", m[2] ?? ""];
}

/** matchAll wrapper yielding the five date/time capture groups of TERMIN_RE. */
function* matchAllTermin(
  text: string,
  re: RegExp,
): Generator<[string, string, string, string, string, string]> {
  for (const m of text.matchAll(re))
    yield [m[0], m[1] ?? "", m[2] ?? "", m[3] ?? "", m[4] ?? "", m[5] ?? ""];
}
