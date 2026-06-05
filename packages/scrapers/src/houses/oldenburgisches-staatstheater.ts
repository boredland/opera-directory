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
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Oldenburgisches Staatstheater (`spielplan-html`, TYPO3, server-rendered).
 *
 * NB the canonical host is `staatstheater.de` (the oldenburgisches-staatstheater.de
 * domain is parked). The /kalender page is server-rendered but windowed to ONE
 * month; it embeds the season's month links as `/kalender?monat=MMYYYY&cHash=…`
 * (the cHash is required), so we follow those. Each day is an `<a data-date="
 * YYYYMMDD">` header followed by `auffuehrung` blocks: an `/programm/musiktheater/…`
 * link (= opera sparte) with the title, "von {Composer}", time and venue. The
 * per-production detail page carries the cast + creative team ("Label: {names}"
 * lines under "Besetzung"). Future/season-only → Wikidata backfill.
 */

const BASE = "https://staatstheater.de";
/** Oldenburgisches Staatstheater on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2018731";

interface Grouped {
  title: string;
  composer: string | null;
  detailPath: string;
  perfs: RawPerformance[];
}

export async function scrapeOldenburgischesStaatstheater(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const bySlug = await walkKalender(ctx, window);
    for (const [slug, g] of bySlug) {
      if (!g.composer || g.perfs.length === 0) continue;
      const prod: RawProduction = {
        source_production_id: slug,
        work_title: g.title,
        composer_name: g.composer,
        detail_url: `${BASE}${g.detailPath}`,
        performances: g.perfs.sort(
          (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
        ),
      };
      try {
        const { cast, creative } = await fetchCredits(ctx, g.detailPath);
        prod.cast = cast;
        prod.creative_team = creative;
      } catch (err) {
        console.warn(`oldenburgisches-staatstheater: credits ${slug} failed:`, err);
      }
      productions.push(prod);
    }
  } catch (err) {
    console.warn("oldenburgisches-staatstheater: kalender failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("oldenburgisches-staatstheater: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "oldenburgisches-staatstheater", productions };
}

/** Walk every month page (the first page lists the season's `?monat=…&cHash=…`
 *  links) and group opera performances by production slug. */
async function walkKalender(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<Map<string, Grouped>> {
  const today = new Date().toISOString().slice(0, 10);
  const first = await fetchHtml(`${BASE}/kalender`, ctx);
  const monthUrls = new Set([`${BASE}/kalender`]);
  for (const m of first.matchAll(/href="(\/kalender\?monat=[^"]+)"/g)) {
    if (m[1]) monthUrls.add(`${BASE}${decodeEntities(m[1])}`);
  }

  const bySlug = new Map<string, Grouped>();
  for (const url of monthUrls) {
    const html = url === `${BASE}/kalender` ? first : await fetchHtml(url, ctx);
    parseKalender(html, bySlug, window, today);
  }
  return bySlug;
}

function parseKalender(
  html: string,
  bySlug: Map<string, Grouped>,
  window: ScrapeWindow,
  today: string,
): void {
  // Each chunk = one day (from its data-date header to the next).
  for (const day of html.split(/data-date="/).slice(1)) {
    const ymd = day.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!ymd) continue;
    const date = `${ymd[1]}-${ymd[2]}-${ymd[3]}` as IsoDate;
    if (window.since && date < window.since) continue;

    for (const ev of day.split(/class="auffuehrung/).slice(1)) {
      const detailPath = ev.match(/href="(\/programm\/musiktheater\/[^"]+)"/)?.[1];
      if (!detailPath) continue; // not an opera-sparte event
      if (/\bmusical\b/i.test(stripHtml(ev.slice(0, 700)))) continue; // drop musicals

      const title = stripHtml(ev.match(/<h2>\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
      const time = ev.match(/class="uhrzeit">\s*(\d{1,2}:\d{2})/)?.[1] ?? null;
      const composer = composerFromText(
        stripHtml(ev.match(/<p>\s*(von\s+[\s\S]*?)<\/p>/)?.[1] ?? ""),
      );
      const venue = stripHtml(ev.match(/class="spielort[^"]*">([\s\S]*?)</)?.[1] ?? "") || null;
      const slug = detailPath.split("/").pop() ?? detailPath;
      if (!title) continue;

      let g = bySlug.get(slug);
      if (!g) {
        g = { title, composer, detailPath, perfs: [] };
        bySlug.set(slug, g);
      }
      if (!g.perfs.some((p) => p.date === date && p.time === time)) {
        g.perfs.push({
          date,
          time,
          venue_room: venue,
          status: date < today ? "past" : "scheduled",
        });
      }
    }
  }
}

/** Detail "Besetzung" block: `<p>` lines "Label: <strong>Name</strong> / <strong>…
 *  </strong><br>…". A label in the German map is a creative function, else a sung
 *  role; alternate casts give several names per label. */
async function fetchCredits(
  ctx: FetchContext,
  detailPath: string,
): Promise<{ cast: RawCredit[]; creative: RawCredit[] }> {
  const html = await fetchHtml(`${BASE}${detailPath}`, ctx);
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const block = html.match(/Besetzung\s*<\/h3>([\s\S]*?)(?:<\/section>|<footer|$)/)?.[1] ?? "";

  for (const p of block.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    for (const line of (p[1] ?? "").split(/<br\s*\/?>/)) {
      const label = stripHtml(line.replace(/:[\s\S]*$/, ""));
      const names = [...line.matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map((m) =>
        stripHtml(m[1] ?? ""),
      );
      if (!label || names.length === 0) continue;
      for (const name of names) {
        if (!name) continue;
        const credit = normalizeGermanCredit(label, name);
        if (credit.function) creative.push(credit);
        else cast.push({ role: label, name });
      }
    }
  }
  return { cast, creative };
}
