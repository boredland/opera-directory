import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchRendered, stripHtml } from "../fetch";
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
 * Theater Ulm (`render`, `proxy: true`).
 *
 * Ulm is a Nuxt SPA whose data lives only in a `window.__NUXT__` blob (not the SSR
 * DOM) — so rather than eval that blob in CI, we let the fetch-proxy's stealth
 * Chromium hydrate the page (`fetchRendered`) and parse the resulting DOM; the
 * page's JS runs on the proxy, never in our pipeline. The /spielplan render lists
 * performance rows ("{time} … / {Sparte}" + a `/spielplan/stuecke/{slug}` link) —
 * keep Sparte "Musiktheater". Each detail render gives the `<h1>` title, a
 * "… von {Composer}" subtitle, a Termine list (`b.stueck-date` "DD/MM/YY") and the
 * cast/creative as `<span class="mr-1">{label}</span> <a …person…><b>{name}</b></a>`
 * pairs. Future/season-only → Wikidata backfill.
 */

const BASE = "https://www.theater-ulm.de";
/** Theater Ulm on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1235650";

export async function scrapeTheaterUlm(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const listing = await fetchRendered(`${BASE}/spielplan`, ctx, { waitMs: 8000 });
    for (const slug of operaSlugs(listing)) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-ulm: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-ulm: listing render failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-ulm: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-ulm", productions };
}

/** Listing rows pair a `stueck-detail` ("… / {Sparte}") with a `stueck-teaser`
 *  `/spielplan/stuecke/{slug}` link; keep the Musiktheater ones. */
function operaSlugs(html: string): string[] {
  const slugs = new Set<string>();
  for (const m of html.matchAll(
    /stueck-detail[^>]*>([\s\S]*?)stueck-teaser[^>]*>\s*<a[^>]*href="\/spielplan\/stuecke\/([^"]+)"/g,
  )) {
    if (/\bMusiktheater\b/.test(m[1] ?? "") && m[2]) slugs.add(m[2]);
  }
  return [...slugs];
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/spielplan/stuecke/${slug}`;
  const raw = await fetchRendered(url, ctx, { waitMs: 8000 });
  const dom = raw.replace(/<script[\s\S]*?<\/script>/g, " ");

  const title = stripHtml(dom.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const subtitle = stripHtml(dom.match(/<\/h1>([\s\S]{0,300})/)?.[1] ?? "");
  const composer = composerFromText(subtitle);
  if (!title || !composer) return null;

  const performances = parseTermine(dom, window);
  if (performances.length === 0) return null;

  const creative = parseCreative(dom);
  // Only the production team renders (sung cast is behind a tab). Require a
  // conductor — it confirms a staged opera and drops dance pieces that share the
  // Musiktheater listing (e.g. a Tanztheater "Choreografie von …").
  if (!creative.some((c) => c.function === "conductor")) return null;

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: creative,
    performances,
  };
}

/** Termine rows carry a `b.stueck-date` "DD/MM/YY"; a "HH.MM"/"HH:MM" time and the
 *  venue follow in the same row. */
function parseTermine(dom: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const row of dom.split(/class="stueck-date/).slice(1)) {
    const dm = row.match(/(\d{2})\/(\d{2})\/(\d{2})/);
    if (!dm) continue;
    const date = `20${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
    const head = row.slice(0, 400);
    const tm = head.match(/(\d{1,2})[.:](\d{2})\s*Uhr/);
    const time = tm ? `${tm[1]?.padStart(2, "0")}:${tm[2]}` : null;
    if ((window.since && date < window.since) || seen.has(`${date}|${time}`)) continue;
    seen.add(`${date}|${time}`);
    const venue = stripHtml(head.match(/stueck-(?:ort|location)[^>]*>([^<]+)</)?.[1] ?? "") || null;
    performances.push({
      date,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** The rendered "production team" rows — `<span class="mr-1">{label}</span>` then a
 *  person `<b>{name}</b>`. All are creative team (the sung cast renders behind a
 *  tab we don't trigger); a label in the German map gets its function, the rest
 *  keep the verbatim German label. */
function parseCreative(dom: string): RawCredit[] {
  const creative: RawCredit[] = [];
  const seen = new Set<string>();

  for (const m of dom.matchAll(
    /<span class="mr-1"[^>]*>([\s\S]*?)<\/span>\s*(?:<a[^>]*>)?\s*<b[^>]*>([\s\S]*?)<\/b>/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    const name = stripHtml(m[2] ?? "");
    if (!label || !name) continue;
    const key = `${label}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const credit = normalizeGermanCredit(label, name);
    creative.push(credit.function ? credit : { function: label, name });
  }
  return creative;
}
