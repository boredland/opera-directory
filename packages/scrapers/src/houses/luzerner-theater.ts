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
 * Luzerner Theater (`spielplan-html` strategy).
 *
 * A multi-genre German-language house in Lucerne, Switzerland presenting Oper,
 * Schauspiel, Tanz and Konzert side by side on a Drupal 10 CMS (server-rendered
 * HTML, no public JSON API, no proxy needed). Discovery is two legs:
 *   - FUTURE (always): the calendar `/spielplan/kalender` server-renders the
 *     complete announced future as one `spielplan-item` per performance night —
 *     each carries the ISO date (`id="YYYY-MM-DD"`), the production detail slug
 *     (`spielplan-item__link href="/{slug}"`), the genre, start time, stage and a
 *     ticket/category badge. Items are grouped by their detail slug into
 *     productions; the per-item composer subtitle ("Oper von …") is the opera
 *     gate. The detail page `/{slug}` then adds creative team + sung cast.
 *   - PAST (backfill): the calendar only reaches forward and the detail pages
 *     render their date list via JS (empty in raw HTML), so there is no scrapable
 *     archive — backfill falls to the shared Wikidata strategy.
 *
 * OPERA GATE — the calendar mixes opera, ballet, drama, concerts and figure
 * theatre, so each performance is kept only when its `spielplan-item__genre`
 * begins "Oper" (covers "Oper", "Operette" and multi-genre "Oper, Tanz"); the
 * composer is taken from the subtitle ("Oper von …", "Komische Oper von …",
 * "Oper nach …") via composerFromText, which is also the REQUIRE-a-composer gate.
 * That drops Schauspiel, Tanz, Konzert and Figurentheater.
 */

const BASE = "https://www.luzernertheater.ch";

/** Luzerner Theater on Wikidata — Q115520768, the "theatre production company"
 *  record (P31 = Q105815710 theatre production company), which carries the
 *  official website (P856 www.luzernertheater.ch) and ~785 production items via
 *  P272. Verified via wbsearchentities (the only other hit, Q1727231, is the
 *  theatre *building*). NB: every P272/P4647 item on either record is an
 *  unlabeled bare-QID, so the wikidata strategy (which skips label-less items)
 *  yields little here — kept as the canonical anchor + best-effort backfill. */
const WIKIDATA_QID = "Q115520768";

export async function scrapeLuzernerTheater(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const bySlug = collectOperaPerformances(
      await fetchHtml(`${BASE}/spielplan/kalender`, ctx),
      window,
    );
    for (const [slug, entry] of bySlug) {
      try {
        const prod = await buildProduction(ctx, slug, entry);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`luzerner-theater: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("luzerner-theater: calendar failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("luzerner-theater: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "luzerner-theater", productions };
}

interface CalendarEntry {
  title: string;
  subtitle: string;
  performances: RawPerformance[];
}

/**
 * Walk the calendar's `spielplan-item` blocks (one per performance night),
 * keeping only opera-genre items, and group them by their detail slug. Each item
 * carries its own ISO date on `id="YYYY-MM-DD"`, so the future leg is fully
 * dated without touching the detail pages.
 */
function collectOperaPerformances(html: string, window: ScrapeWindow): Map<string, CalendarEntry> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, CalendarEntry>();

  const itemRe =
    /<div id="(\d{4}-\d{2}-\d{2})" class="spielplan-item [\s\S]*?(?=<div id="\d{4}-\d{2}-\d{2}" class="spielplan-item |<!-- END)/g;
  for (const [block, date] of html.matchAll(itemRe)) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const genre = stripHtml(
      block.match(/spielplan-item__genre-items"?>([\s\S]*?)<\/p>/)?.[1] ?? "",
    );
    if (!/^oper(ette)?\b/i.test(genre.trim())) continue;
    if (window.since && date < window.since) continue;

    const slug = block.match(/spielplan-item__link"\s+href="\/([a-z0-9_-]+)"/i)?.[1];
    if (!slug) continue;

    const title = stripHtml(
      block.match(/spielplan-item__title"?>\s*<h2>([\s\S]*?)<\/h2>/)?.[1] ?? "",
    )
      .replace(/^entfällt:\s*/i, "")
      .trim();
    const subtitle = stripHtml(
      block.match(/spielplan-item__subtitle"?>\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "",
    );

    const entry = bySlug.get(slug) ?? { title, subtitle, performances: [] };
    if (!entry.title && title) entry.title = title;
    if (!entry.subtitle && subtitle) entry.subtitle = subtitle;

    const cancelled = /tickets_available[^"]*not-active|>\s*Entfällt\s*</i.test(block);
    entry.performances.push({
      date: date as IsoDate,
      time: parseTime(block),
      venue_room: parseStage(block),
      status: cancelled ? "cancelled" : date < today ? "past" : "scheduled",
    });
    bySlug.set(slug, entry);
  }

  return bySlug;
}

/** "19.30\n - \n22.20 Uhr" → "19:30" (start time only). */
function parseTime(block: string): string | null {
  const m = block.match(/spielplan-item__time"?>\s*<p>\s*(\d{1,2})\.(\d{2})/);
  return m ? `${m[1]?.padStart(2, "0")}:${m[2]}` : null;
}

/** The stage chip — `spielplan-item__stage > span` (Bühne, Box, UG, Foyer …). */
function parseStage(block: string): string | null {
  const m = block.match(/spielplan-item__stage[^>]*>\s*<span>([\s\S]*?)<\/span>/);
  return m?.[1] ? stripHtml(m[1]) || null : null;
}

/**
 * Build a production from its calendar grouping + detail page. The composer is
 * taken from the calendar subtitle (opera gate); the detail page adds the
 * creative team (`production-crew-list`, German labels) and sung cast
 * (`production-cast-list`, role → singer).
 */
async function buildProduction(
  ctx: FetchContext,
  slug: string,
  entry: CalendarEntry,
): Promise<RawProduction | null> {
  const url = `${BASE}/${slug}`;
  let html = "";
  try {
    html = await fetchHtml(url, ctx);
  } catch (err) {
    console.warn(`luzerner-theater: detail ${url} failed:`, err);
  }

  const title = entry.title || parseDetailTitle(html);
  const subtitle = entry.subtitle || parseDetailSubtitle(html);
  const composer = composerFromText(subtitle);
  if (!title || !composer) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `luzerner-theater/${slug}`,
    work_title: title,
    composer_name: composer,
    is_revival: /\bwiederaufnahme\b/i.test(html),
    presentation_note: subtitle || null,
    detail_url: url,
    image_url: parseImage(html),
    creative_team,
    cast,
    performances: entry.performances,
  };
}

function parseDetailTitle(html: string): string {
  return stripHtml(
    html.match(/field--name-field-production-title[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "",
  );
}

function parseDetailSubtitle(html: string): string {
  const m =
    html.match(/field--name-field-production-sub-title[^>]*>([\s\S]*?)<\/div>/) ??
    html.match(/field--name-field-production-subtitle-de[^>]*>([\s\S]*?)<\/div>/);
  return stripHtml(m?.[1] ?? "");
}

function parseImage(html: string): string | null {
  const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  return m?.[1]?.trim() || null;
}

/**
 * Detail-page credits. The creative team lives in `<ul class="production-crew-list">`
 * and the sung cast in `<ul class="production-cast-list">`; both share the same
 * `<li class="cast-row">Label – <div class="role-persons">…names…</div></li>`
 * shape, where a name is an `<a class="person">` or a plain `<span>`. Crew labels
 * map via normalizeGermanCredit (verbatim fallback); cast labels are sung roles.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  return {
    creative_team: parseCastRows(html, "production-crew-list", true),
    cast: parseCastRows(html, "production-cast-list", false),
  };
}

function parseCastRows(html: string, listClass: string, isCrew: boolean): RawCredit[] {
  const block = html.match(new RegExp(`<ul class="${listClass}">([\\s\\S]*?)</ul>`))?.[1];
  if (!block) return [];

  const credits: RawCredit[] = [];
  const seen = new Set<string>();
  for (const [, row] of block.matchAll(/<li class="cast-row">([\s\S]*?)<\/li>/g)) {
    if (!row) continue;
    const label = parseRowLabel(row);
    // Crew rows always print a function label; a label-less crew row is noise.
    if (isCrew && !label) continue;
    for (const name of parseRowNames(row)) {
      const credit = isCrew
        ? withFallback(normalizeGermanCredit(label, name), label)
        : label
          ? { role: label, name }
          : { name };
      const key = `${credit.function ?? credit.role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      credits.push(credit);
    }
  }
  return credits;
}

/** The role/function label is the plain text before the first `role-persons`
 *  wrapper, with its trailing "–" separator dropped. Cast rows without a printed
 *  role start with `role-persons` directly, yielding an empty label. */
function parseRowLabel(row: string): string {
  const head = row.split(/<div class="role-persons\b/)[0] ?? "";
  return stripHtml(head)
    .replace(/[–-]\s*$/, "")
    .trim();
}

/** Names in a row: linked `<a class="person">` or plain `<span>` inside a
 *  `role-persons` wrapper. The activity-date `<span class="numeric date-detail">`
 *  block is excluded by requiring the name to sit in a `role-persons` div. */
function parseRowNames(row: string): string[] {
  const names: string[] = [];
  for (const [, wrapper] of row.matchAll(/class="role-persons\b[^"]*">([\s\S]*?)<\/div>/g)) {
    if (!wrapper) continue;
    const m =
      wrapper.match(/class="person"[^>]*>([\s\S]*?)<\/a>/) ??
      wrapper.match(/<span>([\s\S]*?)<\/span>/);
    const name = m?.[1] ? stripHtml(decodeEntities(m[1])) : "";
    if (name) names.push(name);
  }
  return names;
}

/** Keep an unmapped German label verbatim as the credit function rather than
 *  mis-filing it as a sung role. */
function withFallback(credit: RawCredit, label: string): RawCredit {
  return credit.function ? credit : { function: label, name: credit.name };
}
