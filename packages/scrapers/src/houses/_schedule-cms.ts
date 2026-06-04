import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScraper, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { parseMeta } from "./_theater-cms";

/**
 * Shared adapter for the schedule-card variant of the German-theatre CMS used by
 * the multi-genre Staatstheater (Aalto-Theater Essen, Staatstheater Wiesbaden, …).
 *
 * Server-rendered: `/{section}/` lists `.performance` cards, each
 * `<div class="performance … js-schedule-element" id="{YYYY-MM-DD}-p{prodId}">`
 * with a `performance__category` (genre — we keep the Musiktheater ones), a
 * `startDate` microdata time, and a link `/{section}/kalender/{slug}/{id}/`. The
 * card `id` carries the date, so we group cards by their production link. Each
 * detail page's `<meta name="description">` is the same "Title, … von Composer,
 * Besetzung: Role: Name, …" run as the other CMS houses → reuse `parseMeta`.
 * Coverage is the server-rendered window (the schedule extends via JS); deep
 * history comes from Wikidata in backfill.
 */
export function makeScheduleCmsScraper(opts: {
  houseSlug: string;
  baseUrl: string;
  /** URL segment the schedule lives under: "programm" (Essen) or "spielplan" (Wiesbaden). */
  section: string;
  wikidataQid: string;
  /** Which `performance__category` values are opera. Defaults to anything "Musiktheater". */
  operaCategory?: RegExp;
}): HouseScraper {
  const { houseSlug, baseUrl, section, wikidataQid } = opts;
  const operaCategory = opts.operaCategory ?? /Musiktheater/i;

  return async (
    ctx: FetchContext,
    window: ScrapeWindow,
  ): Promise<{ house_slug: string; productions: RawProduction[] }> => {
    const listing = await fetchHtml(`${baseUrl}/${section}/`, ctx);
    const today = new Date().toISOString().slice(0, 10);
    const linkRe = new RegExp(`/${section}/kalender/[a-z0-9-]+/\\d+/`);

    const cardStart =
      /<div class="performance [^"]*js-schedule-element" id="(\d{4}-\d{2}-\d{2})-p\d+"/g;
    const matches = [...listing.matchAll(cardStart)];
    // The link id is per-performance (Otello → /otello/2979/, /otello/2980/), so the
    // slug is the production key — group cards by slug, keeping one link to fetch the detail.
    const bySlug = new Map<string, { link: string; performances: RawPerformance[] }>();

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      if (!m) continue;
      const date = m[1] as IsoDate;
      const slice = listing.slice(m.index, matches[i + 1]?.index ?? m.index + 4000);
      const category = stripHtml(slice.match(/performance__category">([^<]*)</)?.[1] ?? "");
      if (!operaCategory.test(category)) continue;
      const link = slice.match(linkRe)?.[0];
      const slug = link?.split("/").filter(Boolean)[2];
      if (!link || !slug) continue;
      if (window.since && date < window.since) continue;
      const time = slice.match(/startDate"\s+content="[^"]*T(\d{2}:\d{2})/)?.[1] ?? null;

      let entry = bySlug.get(slug);
      if (!entry) {
        entry = { link, performances: [] };
        bySlug.set(slug, entry);
      }
      entry.performances.push({ date, time, status: date < today ? "past" : "scheduled" });
    }

    const productions: RawProduction[] = [];
    for (const { link, performances } of bySlug.values()) {
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
    .replace(/:\s*$/, "")
    .trim();
  if (!workTitle) return null;

  const meta = decodeEntities(
    html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/)?.[1] ?? "",
  );
  // The Musiktheater category also carries non-operas (guided tours, children's
  // concerts). A real work names its composer as "… von Composer" before the
  // Besetzung run; without one, treat the card as not-an-opera and drop it.
  const besetzungAt = meta.search(/[A-Za-zÄÖÜ]*[Bb]esetzung:/);
  const head = besetzungAt >= 0 ? meta.slice(0, besetzungAt) : meta;
  const composer =
    head
      .match(/\bvon\s+([A-ZÄÖÜ][^,]{1,80})/)?.[1]
      ?.split(/\s+nach\s+|\s+und\s+/i)[0]
      ?.trim() ?? null;
  if (!composer) return null;
  const { creative_team, cast } = parseMeta(meta, workTitle);

  const seen = new Set<string>();
  const deduped = performances
    .filter((p) => {
      const key = `${p.date}|${p.time ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));

  return {
    // The slug is the stable production key; the link's trailing id is per-performance
    // and shifts between runs, so keying on it would re-mint the production each time.
    source_production_id: link.split("/").filter(Boolean)[2] ?? link,
    work_title: workTitle,
    composer_name: composer,
    detail_url: `${baseUrl}${link}`,
    creative_team,
    cast,
    performances: deduped,
  };
}
