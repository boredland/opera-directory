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
 * Staatstheater Nürnberg (`spielplan-html` strategy).
 *
 * Contentful-backed but server-rendered. The season page `/spielzeit-{YY-YY}`
 * takes a `?sparte=Oper` filter that lists the season's opera productions, each
 * linked as `spielplan-{YY-YY}/{slug}/{DD-MM-YYYY}/{HHMM}` (date + time in the
 * URL). Any such link renders the production detail, which carries every
 * performance as the same date-stamped link, the creative team as
 * `<p class="… col-sm-3">Label</p><p class="… col-sm-9 link">Name</p>` pairs, and
 * the sung cast as `<p class="link"><a href="kuenstler/…">Name</a></p><p>Role</p>`
 * pairs. Composer comes from the `<meta description>` ("… die Oper von Composer").
 * Future-only → deep history from Wikidata in backfill.
 */

const BASE = "https://www.staatstheater-nuernberg.de";
/** Staatstheater Nürnberg on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q883512";

/** Ensemble/institution "roles" that are not a sung part — dropped from the cast. */
const INSTITUTIONAL = /^(Orchester|Chor|Extrachor|Kinderchor|Statisterie|Chorzuzug)$/i;

export async function scrapeStaatstheaterNuernberg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const slugToLink = new Map<string, string>();
  for (const season of currentSeasons()) {
    let listing: string;
    try {
      listing = await fetchHtml(`${BASE}/spielzeit-${season}?sparte=Oper`, ctx);
    } catch {
      continue; // season not published yet
    }
    for (const m of listing.matchAll(
      /(spielplan-[0-9-]+\/([a-z0-9-]+)\/\d{2}-\d{2}-\d{4}\/\d{3,4})/g,
    )) {
      const link = m[1];
      const slug = m[2];
      if (link && slug && !slugToLink.has(slug)) slugToLink.set(slug, link);
    }
  }

  const productions: RawProduction[] = [];
  for (const [slug, link] of slugToLink) {
    try {
      const prod = await buildProduction(ctx, slug, link, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`staatstheater-nuernberg: ${slug} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatstheater-nuernberg: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatstheater-nuernberg", productions };
}

/** German seasons run roughly August→July; cover the current one and the next. */
function currentSeasons(): string[] {
  const now = new Date();
  const yy = now.getUTCFullYear() % 100;
  const start = now.getUTCMonth() + 1 >= 8 ? yy : yy - 1;
  const fmt = (a: number) => `${String(a).padStart(2, "0")}-${String(a + 1).padStart(2, "0")}`;
  return [fmt(start), fmt(start + 1)];
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  link: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}/${link}`, ctx);
  const workTitle = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "")
    .replace(/[­]|&shy;/g, "")
    .trim();
  if (!workTitle) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html);
  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: parseComposer(html),
    detail_url: `${BASE}/${link}`,
    creative_team,
    cast,
    performances,
  };
}

/** Meta description: "… inszeniert die Oper von Richard Wagner. Alle Termine …". */
function parseComposer(html: string): string | null {
  const meta = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/)?.[1] ?? "";
  const m = stripHtml(meta).match(/\bvon\s+([A-ZÄÖÜ][^.,]{2,40})/);
  return m?.[1]?.trim() || null;
}

/** Two markups: creative `<p class="…col-sm-3">Label</p><p class="…col-sm-9 link">Name</p>`,
 *  and cast `<p class="link"><a href="kuenstler/…">Name</a></p><p>Role, description</p>`. */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  const add = (rawLabel: string, name: string) => {
    if (!rawLabel || !name) return;
    const label = /Dirigat/i.test(rawLabel) ? "Musikalische Leitung" : rawLabel;
    const credit = normalizeGermanCredit(label, name);
    const key = `${credit.function ?? credit.role}|${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (credit.function) creative_team.push(credit);
    else cast.push(credit);
  };

  for (const m of html.matchAll(
    /<p class="col-xs-12 col-sm-3">([^<]*)<\/p>\s*<p class="col-xs-12 col-sm-9[^"]*">([\s\S]*?)<\/p>/g,
  )) {
    add(stripHtml(m[1] ?? ""), stripHtml(m[2] ?? ""));
  }
  for (const m of html.matchAll(
    /<p class="link">\s*<a href="kuenstler\/[^"]*"[^>]*>([^<]*)<\/a>\s*<\/p>\s*<p>([^<]*)<\/p>/g,
  )) {
    const role =
      stripHtml(m[2] ?? "")
        .split(",")[0]
        ?.trim() ?? "";
    if (INSTITUTIONAL.test(role)) continue;
    add(role, stripHtml(m[1] ?? ""));
  }
  return { creative_team, cast };
}

/** Every performance is a `spielplan-…/{slug}/{DD-MM-YYYY}/{HHMM}` link on the detail page. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /spielplan-[0-9-]+\/[a-z0-9-]+\/(\d{2})-(\d{2})-(\d{4})\/(\d{2})(\d{2})/g,
  )) {
    const date = `${m[3]}-${m[2]}-${m[1]}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = `${m[4]}:${m[5]}`;
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}
