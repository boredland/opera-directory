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
 * Landestheater Coburg (`spielplan-html`, Kirby CMS, server-rendered, no proxy).
 *
 * The Musiktheater section index /programm/musiktheater links each production at
 * /programm/musiktheater/{slug}. Detail: `<h1>` title, a "{genre} von {Composer}"
 * `page-header-subtitle`, a `section-besetzung` creative team (`text-table-entry`
 * = `<p>Name</p><p>(Label)</p>`; no singer→role cast is published), and an
 * upcoming-only Termine calendar (`span.date "DD.MM."` — NO year, so inferred —
 * + a `data-time` and `data-location` venue). The section mixes in musicals →
 * dropped via the subtitle genre. Future-only → Wikidata backfill.
 */

const BASE = "https://landestheater-coburg.de";
/** Landestheater Coburg on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1802662";

export async function scrapeLandestheaterCoburg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(`${BASE}/programm/musiktheater`, ctx);
    const slugs = [...new Set(index.match(/\/programm\/musiktheater\/([a-z0-9-]+)/g) ?? [])].map(
      (p) => p.replace("/programm/musiktheater/", ""),
    );
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`landestheater-coburg: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("landestheater-coburg: index failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("landestheater-coburg: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "landestheater-coburg", productions };
}

async function buildProduction(ctx: FetchContext, slug: string): Promise<RawProduction | null> {
  const url = `${BASE}/programm/musiktheater/${slug}`;
  const html = await fetchHtml(url, ctx);
  const subtitle = stripHtml(html.match(/page-header-subtitle">([\s\S]*?)<\/div>/)?.[1] ?? "");
  if (/\bmusical\b/i.test(subtitle)) return null;
  const composer = composerFromText(subtitle);
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!title || !composer) return null;

  const performances = parseTermine(html);
  if (performances.length === 0) return null;

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: parseCreative(html),
    performances,
  };
}

/** Termine rows: `<span class="date b1">DD.MM.</span>` then an `event-entry` with a
 *  `data-time` "HH:MM Uhr" and a `data-location` venue. Dates carry no year and the
 *  list is upcoming-only, so the year is inferred relative to today. */
function parseTermine(html: string): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const year = Number.parseInt(today.slice(0, 4), 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const row of html.split('class="date b1">').slice(1)) {
    const dm = row.match(/^(\d{2})\.(\d{2})\./);
    if (!dm) continue;
    const candidate = `${year}-${dm[2]}-${dm[1]}`;
    const date = (candidate >= today ? candidate : `${year + 1}-${dm[2]}-${dm[1]}`) as IsoDate;
    const entry = row.split('class="date b1">')[0] ?? row; // bound to this row's event-entry
    const time = entry.match(/data-time[^>]*>\s*<p>(\d{1,2}:\d{2})/)?.[1] ?? null;
    if (seen.has(`${date}|${time}`)) continue;
    seen.add(`${date}|${time}`);
    performances.push({
      date,
      time,
      venue_room:
        stripHtml(entry.match(/data-location[^>]*>\s*<p>([^<]+)<\/p>/)?.[1] ?? "") || null,
      status: date < today ? "past" : "scheduled",
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** `section-besetzung` `text-table-entry` rows: `<p>Name</p><p>(Label)</p>` — all
 *  creative team (no sung cast published). Map known German labels, keep the rest
 *  as verbatim creative functions. */
function parseCreative(html: string): RawCredit[] {
  const creative: RawCredit[] = [];
  for (const e of html.split('class="text-table-entry"').slice(1)) {
    const ps = [...e.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => stripHtml(m[1] ?? ""));
    const name = ps[0] ?? "";
    const label = (ps[1] ?? "").replace(/^\(|\)$/g, "").trim();
    if (!name || !label) continue; // empty label = orchestra/ensemble blurb
    const credit = normalizeGermanCredit(label, name);
    creative.push(credit.function ? credit : { function: label, name });
  }
  return creative;
}
