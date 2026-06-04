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
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Komische Oper Berlin (`spielplan-html` strategy).
 *
 * Server-rendered (the month calendar is JS-paginated, but the default
 * `/spielplan/` server-renders the upcoming window — enough during the current
 * Schillertheater renovation programme). Each performance block carries
 * `data-return-point="{YYYY-MM-DD}-p{id}"` (date + production id) and a link
 * `/spielplan/kalender/{slug}/{id}/`. We group by production; each detail page's
 * `<meta name="description">` reads "Title, Composer, … Besetzung: Role: Name, …,
 * Musikalische Leitung: Name, …" — composer is the 2nd field, cast + creative the
 * colon-comma run. Future-only → deep history from Wikidata in backfill.
 */

const BASE = "https://www.komische-oper-berlin.de";
/** Komische Oper Berlin (the house) on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q687694";

export async function scrapeKomischeOperBerlin(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const listing = await fetchHtml(`${BASE}/spielplan/`, ctx);
  const today = new Date().toISOString().slice(0, 10);

  // Group performance dates by production link.
  const byLink = new Map<string, RawPerformance[]>();
  for (const m of listing.matchAll(
    /data-return-point="(\d{4}-\d{2}-\d{2})-p\d+"[\s\S]{0,400}?href="(\/spielplan\/kalender\/[a-z0-9-]+\/\d+\/)"/g,
  )) {
    const date = m[1] as IsoDate;
    const link = m[2] ?? "";
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
      const prod = await buildProduction(ctx, link, performances);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`komische-oper-berlin: ${link} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("komische-oper-berlin: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "komische-oper-berlin", productions };
}

async function buildProduction(
  ctx: FetchContext,
  link: string,
  performances: RawPerformance[],
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}${link}`, ctx);
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
    detail_url: `${BASE}${link}`,
    creative_team,
    cast,
    performances: deduped,
  };
}

/** Meta: "Title, Composer, Subtitle [year] … Besetzung: Role: Name, …, Funktion: Name, …". */
function parseMeta(
  meta: string,
  title: string,
): { composer: string | null; creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];

  // Composer is the field right after the title (before the subtitle / "[year]").
  const afterTitle = meta.startsWith(title) ? meta.slice(title.length).replace(/^,\s*/, "") : meta;
  const composerCand = afterTitle.split(",")[0]?.trim() ?? "";
  const composer =
    composerCand &&
    !composerCand.includes(":") &&
    composerCand.length <= 45 &&
    /[A-Za-zÄÖÜ]/.test(composerCand)
      ? composerCand
      : null;

  // Cast + creative live in the "Besetzung: …" colon-comma run.
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
