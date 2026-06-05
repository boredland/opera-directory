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
 * Theater Bielefeld (`spielplan-html` strategy).
 *
 * Bielefeld's stages run under buo-bielefeld.de (theater-bielefeld.de 301s there).
 * TYPO3, server-rendered. The "Gesang" sparte page
 * `/theater/aktuelle-spielzeit/gesang` lists the whole Musiktheater sparte as cards
 * linking to `/{theater,philharmoniker}/veranstaltung/{slug}` — kept as-is (the
 * sparte mixes opera/operetta/musical, like the Regensburg/Aachen Musiktheater
 * sparte; the free-text genre line is too inconsistent to filter on — "Dramma
 * lirico", "Comic Operetta", …). Each detail page: title `<h1 class="font-extrabold">`,
 * composer `<h2 class="font-extralight">` (a subtitle on the philharmoniker pages →
 * nulled), performances as `font-bold` date + `font-light` time (rendered twice in
 * mobile+desktop accordions → de-duped), cast/team as `/person/` teaser links whose
 * `aria-label` packs "Name, role…". Future-only → Wikidata backfill.
 */

const BASE = "https://www.buo-bielefeld.de";
/** Theater Bielefeld on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415721";

export async function scrapeTheaterBielefeld(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  const listing = await fetchHtml(`${BASE}/theater/aktuelle-spielzeit/gesang`, ctx);
  const paths = new Set(
    [...listing.matchAll(/href="(\/(?:theater|philharmoniker)\/veranstaltung\/[^"#?]+)"/g)].map(
      (m) => m[1] ?? "",
    ),
  );
  for (const path of paths) {
    if (!path) continue;
    try {
      const prod = await buildProduction(ctx, path, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`theater-bielefeld: ${path} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-bielefeld: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-bielefeld", productions };
}

async function buildProduction(
  ctx: FetchContext,
  path: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}${path}`;
  const html = await fetchHtml(detailUrl, ctx);

  const workTitle = stripHtml(
    html.match(/<h1 class="font-extrabold"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "",
  );
  if (!workTitle) return null;
  // h2 is the composer on theater pages but a "/"-joined subtitle on the
  // philharmoniker concert pages — keep it only when it reads like a name.
  const h2 = stripHtml(html.match(/<h2 class="font-extralight"[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "");
  const composer =
    h2 && !h2.includes("/") && !/konzert|symphonie/i.test(h2) && h2.length <= 60 ? h2 : null;

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];
  for (const m of html.matchAll(
    /<span class="font-bold">(\d{2})\.(\d{2})\.(\d{4})<\/span>\s*<span class="font-light[^"]*">\s*(\d{1,2}:\d{2})/g,
  )) {
    const date = `${m[3]}-${m[2]}-${m[1]}` as IsoDate;
    const time = m[4] ?? null;
    if (window.since && date < window.since) continue;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    performances.push({ date, time, status: date < today ? "past" : "scheduled" });
  }
  if (performances.length === 0) return null;
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  const { creative_team, cast } = parseCredits(html);
  return {
    source_production_id: path.split("/").pop() ?? path,
    work_title: workTitle,
    composer_name: composer,
    detail_url: detailUrl,
    creative_team,
    cast,
    performances,
  };
}

/** Person teasers carry `<a aria-label="Name, role[, role…]" … href="/person/…">`.
 *  Name is the first comma-segment, the next is the function/role. A mapped German
 *  function → creative team; anything else (character name) → sung cast. */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a[^>]*aria-label="([^"]+)"[^>]*href="\/person\/[^"]*"/g)) {
    const parts = stripHtml(m[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const name = parts[0];
    const label = parts[1];
    if (!name || !label || seen.has(`${label}|${name}`)) continue;
    seen.add(`${label}|${name}`);
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative_team.push(credit);
    else cast.push(credit);
  }
  return { creative_team, cast };
}
