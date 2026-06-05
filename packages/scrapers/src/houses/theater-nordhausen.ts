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
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Theater Nordhausen (`spielplan-html`, Contao CMS, server-rendered, no proxy).
 *
 * /spielplan is one page; each performance `<li>` carries `data-sparten` — keep
 * "musiktheater". Productions link to `/musiktheater/{slug}` detail pages: title
 * in `<h2 class='titel'>`, "{genre} von {Composer}" in `<p class="utitel">`, the
 * full date list in `div.details_kalender` (each `<li>` has a `data-title`
 * "…-DD-MM-YYYY" + a time + an `.ort` venue) and a `div.besetzung > dl` where a
 * `<dt class="spacer">` separates the creative team (German labels) from the sung
 * roles. "Oper hautnah" preview events, galas (no composer) and musicals are
 * dropped. Future/season-only → Wikidata backfill.
 */

const BASE = "https://theater-nordhausen.de";
/** Theater Nordhausen on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q46810062";

export async function scrapeTheaterNordhausen(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(`${BASE}/spielplan`, ctx);
    const slugs = new Set<string>();
    for (const m of index.matchAll(
      /data-sparten="musiktheater"[\s\S]*?<a href="(musiktheater\/[^"]+)"/g,
    )) {
      const slug = m[1];
      // "Oper hautnah …" are short companion/preview events, not the staging.
      if (slug && !/musiktheater\/oper-hautnah/.test(slug)) slugs.add(slug);
    }
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-nordhausen: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-nordhausen: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-nordhausen: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-nordhausen", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/${slug}`;
  const html = await fetchHtml(url, ctx);
  const utitel = stripHtml(html.match(/<p class="utitel">([\s\S]*?)<\/p>/)?.[1] ?? "");
  if (/\bmusical\b/i.test(utitel)) return null; // dropped: musical, not opera/operette
  const composer = composerFromText(utitel);
  const title = stripHtml(
    html.match(/<h2[^>]*class=["']titel["'][^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "",
  );
  if (!title || !composer) return null; // galas have no "{genre} von {composer}"

  const performances = parseKalender(html, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseBesetzung(html);
  return {
    source_production_id: slug.replace("musiktheater/", ""),
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** `div.details_kalender` rows: a `data-title` ending in "-DD-MM-YYYY", a `.time`
 *  ("HH:MM Uhr") and an `.ort` venue (which may be a guest house). */
function parseKalender(html: string, window: ScrapeWindow): RawPerformance[] {
  const block = html.match(/details_kalender([\s\S]*?)<\/ul>/)?.[1] ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const li of block.split("<li").slice(1)) {
    const dmy = li.match(/data-title="[^"]*-(\d{2})-(\d{2})-(\d{4})"/);
    if (!dmy) continue;
    const date = `${dmy[3]}-${dmy[2]}-${dmy[1]}` as IsoDate;
    const time = li.match(/class="time">\s*(\d{1,2}:\d{2})/)?.[1] ?? null;
    if ((window.since && date < window.since) || seen.has(`${date}|${time}`)) continue;
    seen.add(`${date}|${time}`);
    performances.push({
      date,
      time,
      venue_room: stripHtml(li.match(/class="ort">([\s\S]*?)<\/span>/)?.[1] ?? "") || null,
      status: date < today ? "past" : "scheduled",
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** `div.besetzung > dl`: creative team `<dt>label</dt><dd>names</dd>` pairs up to a
 *  `<dt class="spacer">`, then sung `<dt>role</dt><dd>singer</dd>` pairs. */
function parseBesetzung(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const block = html.match(/class="besetzung"([\s\S]*?)<\/dl>/)?.[1] ?? "";
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  let inCast = false;

  for (const m of block.matchAll(/<dt([^>]*)>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    if (/spacer/.test(m[1] ?? "")) {
      inCast = true;
      continue;
    }
    const label = stripHtml(m[2] ?? "");
    if (!label) continue; // empty labels carry ensemble/chorus blurbs — skip
    const names = [...(m[3] ?? "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((n) =>
      stripHtml(n[1] ?? ""),
    );
    for (const name of names.length ? names : [stripHtml(m[3] ?? "")]) {
      if (!name) continue;
      if (inCast) cast.push({ role: label, name });
      else {
        const credit = normalizeGermanCredit(label, name);
        creative.push(credit.function ? credit : { function: label, name });
      }
    }
  }
  return { cast, creative };
}
