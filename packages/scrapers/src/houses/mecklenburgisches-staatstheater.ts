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
 * Mecklenburgisches Staatstheater Schwerin (`spielplan-html` strategy).
 *
 * Contao CMS. The dated performances live on `/kalendarium.html` as rows whose
 * class carries the sparte (`musiktheater`) and whose ticket/onclick link encodes
 * date + production:
 * `programm/{slug}/am/{DD}-{Monat}-{YYYY}-um-{HH}-{MM}.html`. Only the current and
 * next month are ever published (re-scrape monthly). Each production detail page
 * `programm/{slug}.html` (Contao `ce_mst2021_produktion`) gives the title (`<h1>`),
 * the composer (the "… von {Composer}" `data-tso="L1"` subtitle) and the Besetzung
 * (`<div class="line"><div class="role">Label</div><a href="mensch/…">Name</a>` —
 * creative team plus the cast, the latter behind `besetzung_line`). Future-only →
 * Wikidata backfill.
 */

const BASE = "https://www.mecklenburgisches-staatstheater.de";
/** Mecklenburgisches Staatstheater on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1915756";

const MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  märz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

export async function scrapeMecklenburgischesStaatstheater(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const perfsBySlug = parseKalendarium(await fetchHtml(`${BASE}/kalendarium.html`, ctx), window);

  const productions: RawProduction[] = [];
  for (const [slug, perfs] of perfsBySlug) {
    try {
      const prod = await buildProduction(ctx, slug, perfs);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`mecklenburgisches-staatstheater: ${slug} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("mecklenburgisches-staatstheater: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "mecklenburgisches-staatstheater", productions };
}

/** Calendar rows: `class="row … termin … {sparte}"` with an inner
 *  `programm/{slug}/am/{DD}-{Monat}-{YYYY}-um-{HH}-{MM}.html` link. Keep the
 *  musiktheater rows; date + time come from that link. */
function parseKalendarium(html: string, window: ScrapeWindow): Map<string, RawPerformance[]> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, RawPerformance[]>();
  const rows = [...html.matchAll(/class="(row[^"]*\btermin\b[^"]*)"/g)];
  for (let i = 0; i < rows.length; i++) {
    const cls = rows[i]?.[1] ?? "";
    if (!/\bmusiktheater\b/.test(cls)) continue;
    const start = (rows[i]?.index ?? 0) + 1;
    const end = rows[i + 1]?.index ?? html.length;
    const seg = html.slice(start, end);
    const am = seg.match(
      /programm\/([^/'"]+)\/am\/(\d{1,2})-([A-Za-zäöüÄÖÜ]+)-(\d{4})-um-(\d{1,2})-(\d{2})/,
    );
    if (!am) continue;
    const month = MONTHS[(am[3] ?? "").toLowerCase()];
    if (!month) continue;
    const date = `${am[4]}-${month}-${am[2]?.padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = `${am[5]?.padStart(2, "0")}:${am[6]}`;
    const slug = am[1] ?? "";
    const list = bySlug.get(slug) ?? [];
    list.push({ date, time, status: date < today ? "past" : "scheduled" });
    bySlug.set(slug, list);
  }
  return bySlug;
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  perfs: RawPerformance[],
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/programm/${slug}.html`;
  const html = await fetchHtml(detailUrl, ctx);
  const workTitle = stripHtml(html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!workTitle) return null;

  // The L1 subtitle wraps an empty `<span class="label">` before the credit text;
  // take everything up to the next subtitle span / block end, then strip tags.
  const composer = composerFromText(
    stripHtml(html.match(/data-tso="L1">([\s\S]*?)(?:<span class="utitle"|<\/div>)/)?.[1] ?? ""),
  );
  const { creative_team, cast } = parseBesetzung(html);

  const seen = new Set<string>();
  const performances = perfs
    .filter((p) => {
      const k = `${p.date}|${p.time ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));

  return {
    source_production_id: slug,
    work_title: workTitle,
    composer_name: composer,
    detail_url: detailUrl,
    creative_team,
    cast,
    performances,
  };
}

/** Besetzung lines: `<div class="line" …><div class="role">Label</div><a
 *  href="mensch/…">Name</a>…`. A mapped German function → creative team; a
 *  character-role label → sung cast. */
function parseBesetzung(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<div class="line[^"]*"[^>]*>\s*<div class="role">([\s\S]*?)<\/div>\s*((?:<a[^>]*>[^<]*<\/a>\s*)+)/g,
  )) {
    const label = stripHtml(m[1] ?? "").replace(/^Besetzung\s+/, "");
    if (!label) continue;
    for (const a of (m[2] ?? "").matchAll(/<a[^>]*>([^<]*)<\/a>/g)) {
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
