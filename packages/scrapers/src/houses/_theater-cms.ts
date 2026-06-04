import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScraper,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Shared adapter for the German-theatre CMS used by several houses (Komische Oper
 * Berlin, Deutsche Oper am Rhein, …) — same template, so one parameterized
 * scraper covers them all.
 *
 * Server-rendered. The default `/spielplan/` lists performance blocks with
 * `data-return-point="{YYYY-MM-DD}-p{id}"` (date + production) and a link
 * `/spielplan/kalender/{slug}/{id}/`. We group by production; each detail page's
 * `<meta name="description">` reads "Title, Composer, … Besetzung: Role: Name, …,
 * Musikalische Leitung: Name, …" — composer is the 2nd field, cast + creative the
 * colon-comma run. Future-only → deep history from Wikidata in backfill.
 *
 * (Month calendar pages are JS-paginated, so coverage is the announced window.)
 */
export function makeTheaterCmsScraper(opts: {
  houseSlug: string;
  baseUrl: string;
  wikidataQid: string;
}): HouseScraper {
  const { houseSlug, baseUrl, wikidataQid } = opts;

  return async (
    ctx: FetchContext,
    window: ScrapeWindow,
  ): Promise<{ house_slug: string; productions: RawProduction[] }> => {
    const listing = await fetchHtml(`${baseUrl}/spielplan/`, ctx);
    const today = new Date().toISOString().slice(0, 10);

    const byLink = new Map<string, RawPerformance[]>();
    for (const m of listing.matchAll(
      /data-return-point="(\d{4}-\d{2}-\d{2})-p\d+"[\s\S]{0,400}?href="(\/spielplan\/kalender\/[a-z0-9-]+\/\d+\/)"|href="(\/spielplan\/kalender\/[a-z0-9-]+\/\d+\/)"[^>]*data-return-point="(\d{4}-\d{2}-\d{2})-p\d+"/g,
    )) {
      const date = (m[1] ?? m[4]) as IsoDate;
      const link = m[2] ?? m[3] ?? "";
      if (!date || !link) continue;
      if (window.since && date < window.since) continue;
      let list = byLink.get(link);
      if (!list) {
        list = [];
        byLink.set(link, list);
      }
      list.push({ date, status: date < today ? "past" : "scheduled" });
    }

    const productions: RawProduction[] = [];
    for (const [link, performances] of byLink) {
      try {
        const prod = await buildProduction(ctx, baseUrl, link, performances);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`${houseSlug}: ${link} failed:`, err);
      }
    }

    if (window.mode === "backfill") {
      try {
        productions.push(...(await scrapeWikidataProductions(wikidataQid, ctx, window)));
      } catch (err) {
        console.warn(`${houseSlug}: wikidata backfill failed:`, err);
      }
    }
    return { house_slug: houseSlug, productions };
  };
}

async function buildProduction(
  ctx: FetchContext,
  baseUrl: string,
  link: string,
  performances: RawPerformance[],
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${baseUrl}${link}`, ctx);
  const workTitle = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "")
    .replace(/[­]|&shy;/g, "")
    .trim();
  if (!workTitle) return null;

  const meta = decodeEntities(
    html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/)?.[1] ?? "",
  );
  const { composer, creative_team, cast } = parseMeta(meta, workTitle);

  const seen = new Set<string>();
  const deduped = performances
    .filter((p) => {
      if (seen.has(p.date)) return false;
      seen.add(p.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    source_production_id: link.replace(/^\/spielplan\/kalender\//, "").replace(/\/$/, ""),
    work_title: workTitle,
    composer_name: composer,
    detail_url: `${baseUrl}${link}`,
    creative_team,
    cast,
    performances: deduped,
  };
}

/** Meta: "Title, Composer, Subtitle … Besetzung: Role: Name, …, Funktion: Name, …". */
function parseMeta(
  meta: string,
  title: string,
): { composer: string | null; creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];

  const afterTitle = meta.startsWith(title) ? meta.slice(title.length).replace(/^,\s*/, "") : meta;
  const composerCand = afterTitle.split(",")[0]?.trim() ?? "";
  const composer =
    composerCand &&
    !composerCand.includes(":") &&
    composerCand.length <= 45 &&
    /[A-Za-zÄÖÜ]/.test(composerCand)
      ? composerCand
      : null;

  const run = meta.slice(meta.indexOf("Besetzung:"));
  if (run.startsWith("Besetzung:")) {
    const seen = new Set<string>();
    for (const segment of run.split(/,\s*/)) {
      const parts = segment.split(":");
      if (parts.length < 2) continue;
      const name = (parts.at(-1) ?? "").trim();
      const role = (parts.at(-2) ?? "").trim();
      if (!role || !name || name.length > 60) continue;
      const key = `${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const credit = normalizeGermanCredit(role, name);
      if (credit.function) creative_team.push(credit);
      else cast.push(credit);
    }
  }
  return { composer, creative_team, cast };
}
