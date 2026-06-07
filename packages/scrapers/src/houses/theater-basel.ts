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
 * Theater Basel / Theater Basel (`spielplan-html` strategy).
 *
 * Switzerland's largest theatre, presenting opera, ballet and Schauspiel side by
 * side. The site is a German-language Drupal 10 SSR build (Cloudflare-fronted but
 * reachable with the polite UA) with NO public JSON API and NO schema.org Event
 * JSON-LD — listing pages (`/de/oper`, `/de/archiv`) are client-rendered, so the
 * only reliable structured data lives on the per-production detail pages, which
 * are server-rendered. Discovery therefore enumerates the single-segment
 * `/de/{slug}` production pages from the XML sitemap and reads each one directly.
 *
 * OPERA GATE — the house mixes opera, operetta, ballet, Schauspiel, Musical,
 * Musiktheater and concerts, so each detail page is gated TWICE:
 *   1. genre badge — `<h1>… <span class="color-red">Oper</span>`. Only "Oper" and
 *      "Operette" pass; that drops Ballett, Schauspiel, Musical, Musiktheater,
 *      Konzert and editorial/landing pages (which carry no badge at all).
 *   2. a composer — the "Werkangaben" credit block's explicit "Musik von …" /
 *      "Musik und Text von …" clause (`… in N Akten · Musik von {Composer} · Text
 *      von {Librettist}`), read by composerFromText. The house publishes
 *      Werkangaben for the announced future programme but not for every trailing
 *      current-season page, and some carry only a devised "von und mit {names}"
 *      credit; a genre-badged page with no explicit composer clause is dropped
 *      (REQUIRE-a-composer). A genitive-prose guess was tried and rejected — it
 *      manufactured false composers ("La Cenerentola" → "In Rossini").
 *
 * Per detail page:
 *   - title: `<title>` (the work title; the `<h1>` interleaves the genre badge).
 *   - composer: the Werkangaben "Musik von …" clause (else the page is dropped).
 *   - performances: `<article class="…activity-teaser…">` rows, each with a
 *     full date (the `field-activity-start` `datetime` attr, in UTC but only the
 *     date is used) and a LOCAL `HH:MM` (the `<time>` element's text, since the
 *     `Z` instant is off by the CET/CEST offset), plus the `field-stage` room.
 *   - creative team: the single `production-crew-list` (`<li>{Label} – {names}`),
 *     mapped via normalizeGermanCredit. The house does not publish a sung-role
 *     cast on production pages, so cast is left empty.
 *
 * Backfill: the live site's archive is JS-rendered and old production pages drop
 * their Werkangaben, so the deep past comes from Wikidata (Q391991), which is the
 * richest source for this house by far.
 */

const BASE = "https://www.theater-basel.ch";

/** Theater Basel on Wikidata — Q391991 ("opera house and drama theatre in Basel,
 *  Switzerland"). Verified via wbsearchentities (which also returns the decoy
 *  Q115462144 "performing arts complex") AND by SPARQL counting P4647/P272 links:
 *  Q391991 carries 10171 production/premiere items vs. 2 for the complex record,
 *  so the house QID is unambiguously the one with usable backfill. */
const WIKIDATA_QID = "Q391991";

/** Genre badges that pass the opera gate (lowercased). Everything else — Ballett,
 *  Schauspiel, Musical, Musiktheater, Konzert — and badge-less landing pages drop. */
const OPERA_GENRES = new Set(["oper", "operette"]);

/** The sitemap is paginated; four pages cover the whole site today. The walk
 *  stops early on the first page that yields no `<loc>`. */
const MAX_SITEMAP_PAGES = 8;

export async function scrapeTheaterBasel(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const detailUrls = await collectDetailUrls(ctx);
    for (const url of detailUrls) {
      try {
        const html = await fetchHtml(url, ctx);
        const prod = parseProduction(html, url, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-basel: detail ${url} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-basel: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-basel: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "theater-basel", productions };
}

/**
 * Collect candidate production detail URLs — the single-segment `/de/{slug}`
 * pages — from the paginated XML sitemap. Listing pages are JS-rendered, so the
 * sitemap is the only complete server-side index; the genre/composer gates on
 * each detail page filter the candidates down to opera.
 */
async function collectDetailUrls(ctx: FetchContext): Promise<string[]> {
  const urls = new Set<string>();
  const slugRe = new RegExp(`<loc>(${BASE}/de/[a-z0-9-]+)</loc>`, "g");

  for (let page = 1; page <= MAX_SITEMAP_PAGES; page++) {
    let xml: string;
    try {
      xml = await fetchHtml(`${BASE}/sitemap.xml?page=${page}`, ctx);
    } catch (err) {
      console.warn(`theater-basel: sitemap page ${page} failed:`, err);
      break;
    }
    // Pages aren't additive — production slugs live on a later page than the
    // marketing pages — so stop only at the true end (a page with no <loc>),
    // not when a single page yields no new opera-shaped slug.
    if (!xml.includes("<loc>")) break;
    for (const [, loc] of xml.matchAll(slugRe)) {
      if (loc) urls.add(loc);
    }
  }

  return [...urls];
}

function parseProduction(html: string, url: string, window: ScrapeWindow): RawProduction | null {
  // OPERA GATE 1 — genre badge in the header; null drops ballet/Schauspiel/Musical
  // and badge-less editorial pages.
  const genre = parseGenre(html);
  if (!genre || !OPERA_GENRES.has(genre.toLowerCase())) return null;

  // OPERA GATE 2 — a composer (Werkangaben "Musik von …", else genitive prose).
  const composer = parseComposer(html);
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html);
  if (!title) return null;

  const slug = url.split("/").pop() ?? url;
  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `theater-basel/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    image_url: parseImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** Genre badge from the header — `<span class="color-red">Oper</span>`. */
function parseGenre(html: string): string | null {
  const m = html.match(/<span class="color-red">\s*([^<]+?)\s*<\/span>/i);
  return m?.[1] ? decodeEntities(m[1]).trim() : null;
}

/** Work title from `<title>`, which is the bare work name ("Le nozze di Figaro");
 *  the `<h1>` interleaves the genre badge, so it's a poorer source. */
function parseTitle(html: string): string | null {
  const m = html.match(/<title>([^<|]*)/i);
  if (!m?.[1]) return null;
  const t = stripHtml(m[1]);
  return t || null;
}

/**
 * Composer, from the "Werkangaben" credit block's `<p>`, whose lines read
 * "… in N Akten · Musik von {Composer} · Text von {Librettist}"; composerFromText
 * reads the "Musik von" / "Musik und Text von" clause and trims the trailing
 * librettist/premiere noise. The `\bMusik\b` boundary avoids matching inside
 * "Musiktheater"; only this explicit-composer clause is accepted — a page whose
 * Werkangaben reads "… von und mit {devisers}" (children's/devised theatre) or
 * has no Werkangaben at all yields null and is dropped by the composer gate. A
 * genitive-prose guess was tried and rejected: it manufactured false composers
 * ("La Cenerentola" → "In Rossini", "Königshausen" → "Königshau").
 */
function parseComposer(html: string): string | null {
  const werk = html.match(
    /Werkangaben[\s\S]*?<div class="paragraph--content">[\s\S]*?<p>([\s\S]*?)<\/p>/i,
  );
  if (!werk?.[1]) return null;
  const text = decodeEntities(werk[1].replace(/<br\s*\/?>/gi, " · "));
  const line = text.match(/\bMusik(?:\s+und\s+Text)?\s+von\s+[^·]+/i)?.[0];
  return line ? composerFromText(line) : null;
}

function parseImage(html: string): string | null {
  const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  return m?.[1]?.trim() || null;
}

/**
 * Performance rows. Each `<article class="…activity-teaser…">` carries one night:
 * the date from the `field-activity-start` `datetime` attr (UTC, but the date is
 * stable), the LOCAL time from the `<time>` element's text (the `Z` instant is off
 * by the CET/CEST offset, so its clock time is wrong), and the `field-stage` room.
 */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const articleRe = /<article class="[^"]*activity-teaser[^"]*"[\s\S]*?<\/article>/g;
  for (const [block] of html.matchAll(articleRe)) {
    const startMatch = block.match(
      /field--name-field-activity-start[\s\S]*?datetime="([^"]+)"[^>]*>\s*([^<]*)<\/time>/i,
    );
    if (!startMatch?.[1]) continue;
    const date = startMatch[1].slice(0, 10) as IsoDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (window.since && date < window.since) continue;

    const timeText = startMatch[2]?.trim() ?? "";
    const time = /^\d{1,2}:\d{2}$/.test(timeText) ? timeText.padStart(5, "0") : null;

    const stage = block.match(
      /field--name-field-stage[\s\S]*?field--name-title[^>]*>\s*([^<]+?)\s*</i,
    );
    const venue_room = stage?.[1] ? decodeEntities(stage[1]).trim() : null;

    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date,
      time,
      venue_room,
      status: date < today ? "past" : "scheduled",
    });
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/**
 * Creative team from the single `production-crew-list`: each `<li>` is
 * "{Label} – {one or more <a class="person">names}". A label the German credit
 * map knows becomes a creative function; an unknown label (e.g. "Movement
 * Director") falls through to a verbatim role. The house does not print a sung
 * cast on production pages, so `cast` is always empty.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();

  const list = html.match(/<ul class="production-crew-list">([\s\S]*?)<\/ul>/i);
  if (!list?.[1]) return { creative_team, cast: [] };

  for (const [, li] of list[1].matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    if (!li) continue;
    const labelMatch = li.match(/^([\s\S]*?)\s*(?:–|&ndash;|&#8211;|&#x2013;|-)\s/);
    const label = labelMatch?.[1] ? stripHtml(labelMatch[1]) : "";
    if (!label) continue;
    for (const [, rawName] of li.matchAll(/class="person"[^>]*>([\s\S]*?)<\/a>/g)) {
      const name = rawName ? stripHtml(rawName) : "";
      if (!name) continue;
      const credit = normalizeGermanCredit(label, name);
      const key = `${credit.function ?? credit.role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push(credit);
    }
  }

  return { creative_team, cast: [] };
}
