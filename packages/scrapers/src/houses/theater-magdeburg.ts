import type { IsoDate } from "@opera-directory/schema";
import { extractEventJsonLd, type FetchContext, fetchHtml, stripHtml } from "../fetch";
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
 * Theater Magdeburg (`spielplan-html` strategy).
 *
 * TYPO3. The Musiktheater index `/inszenierungen/musiktheater/` lists every opera
 * production (title in `<strong>`, "Genre von Composer" in `<p class="utitel">`,
 * detail link `/inszenierungen/musiktheater/sz-{season}/{group}/{slug}/`). Detail
 * pages carry the creative team + cast (`<i>Label</i><a href="/menschen/…">Name</a>`
 * pairs) but no dates. The dates live on `/spielplan/spielplan/` as schema.org
 * `MusicEvent` JSON-LD (`startDate` + the production `url`), full season on one
 * page — matched back to a production by URL prefix. Future-only → Wikidata backfill.
 */

const BASE = "https://www.theater-magdeburg.de";
/** Theater Magdeburg on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1521622";
const MT_PREFIX = "/inszenierungen/musiktheater/";

interface IndexEntry {
  slug: string;
  detailPath: string;
  work_title: string;
  composer: string | null;
}

export async function scrapeTheaterMagdeburg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const index = parseIndex(await fetchHtml(`${BASE}${MT_PREFIX}`, ctx));
  // longest detailPath first so a sub-page event (…/{slug}/{sub}/) matches the
  // production, not a shorter sibling whose path is also a prefix.
  const byPathLen = [...index].sort((a, b) => b.detailPath.length - a.detailPath.length);

  const perfsBySlug = new Map<string, RawPerformance[]>();
  const today = new Date().toISOString().slice(0, 10);
  for (const ev of extractEventJsonLd(await fetchHtml(`${BASE}/spielplan/spielplan/`, ctx))) {
    const url = typeof ev.url === "string" ? ev.url : "";
    const start = typeof ev.startDate === "string" ? ev.startDate : "";
    if (!url.includes(MT_PREFIX) || !start) continue;
    const path = new URL(url, BASE).pathname;
    const prod = byPathLen.find((p) => path.startsWith(p.detailPath));
    if (!prod) continue;
    const date = start.slice(0, 10) as IsoDate;
    if (window.since && date < window.since) continue;
    const time = /T(\d{2}:\d{2})/.exec(start)?.[1] ?? null;
    const list = perfsBySlug.get(prod.slug) ?? [];
    list.push({ date, time, status: date < today ? "past" : "scheduled" });
    perfsBySlug.set(prod.slug, list);
  }

  const productions: RawProduction[] = [];
  for (const entry of index) {
    const perfs = dedupeSort(perfsBySlug.get(entry.slug) ?? []);
    if (perfs.length === 0) continue;
    try {
      productions.push(await buildProduction(ctx, entry, perfs));
    } catch (err) {
      console.warn(`theater-magdeburg: ${entry.slug} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-magdeburg: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-magdeburg", productions };
}

/** Index cards: `<a href="/inszenierungen/musiktheater/…/{slug}/"> … <strong>Title
 *  </strong> … <p class="utitel">Genre von Composer</p>`. */
function parseIndex(html: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<a href="(\/inszenierungen\/musiktheater\/[^"]+\/)">[\s\S]*?<strong>([\s\S]*?)<\/strong>[\s\S]*?<p class="utitel">([\s\S]*?)<\/p>/g,
  )) {
    const detailPath = m[1] ?? "";
    const slug = detailPath.replace(/\/$/, "").split("/").pop() ?? "";
    const work_title = stripHtml(m[2] ?? "");
    if (!slug || !work_title || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, detailPath, work_title, composer: composerFromText(stripHtml(m[3] ?? "")) });
  }
  return out;
}

async function buildProduction(
  ctx: FetchContext,
  entry: IndexEntry,
  performances: RawPerformance[],
): Promise<RawProduction> {
  const detailUrl = `${BASE}${entry.detailPath}`;
  const { creative_team, cast } = parseBesetzung(await fetchHtml(detailUrl, ctx));
  return {
    source_production_id: entry.slug,
    work_title: entry.work_title,
    composer_name: entry.composer,
    detail_url: detailUrl,
    creative_team,
    cast,
    performances,
  };
}

/** Besetzung pairs: `<i>Label</i>` followed by one or more `<a href="/menschen/…">
 *  Name</a>` (joined by `/` / `<br>`). A mapped German function → creative team; a
 *  character-role label → sung cast. */
function parseBesetzung(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<i>([^<]+)<\/i>((?:\s*<a href="\/menschen\/[^"]*"[^>]*>[^<]*<\/a>\s*\/?\s*(?:<br\s*\/?>)?)+)/g,
  )) {
    const label = stripHtml(m[1] ?? "");
    if (!label) continue;
    for (const a of (m[2] ?? "").matchAll(/<a href="\/menschen\/[^"]*"[^>]*>([^<]*)<\/a>/g)) {
      const name = stripHtml(a[1] ?? "");
      if (!name || seen.has(`${label}|${name}`)) continue;
      seen.add(`${label}|${name}`);
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative_team.push(credit);
      else cast.push(credit);
    }
  }
  return { creative_team, cast };
}

function dedupeSort(perfs: RawPerformance[]): RawPerformance[] {
  const seen = new Set<string>();
  return perfs
    .filter((p) => {
      const k = `${p.date}|${p.time ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}
