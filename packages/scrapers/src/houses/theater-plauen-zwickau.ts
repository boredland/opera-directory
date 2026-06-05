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
 * Theater Plauen-Zwickau (`spielplan-html`, custom PHP CMS, server-rendered).
 *
 * /spielplan/ is one page of `div.event` performance rows whose class carries the
 * sparte token (`musiktheater`) plus a `city-N`; the row's `a.title` links to
 * `spielplan.php?seite=0&id={id}` (the production id), with the title, a
 * "{genre} von {Composer}" subtitle, a `complete_date` (DD.MM.YYYY), a time and a
 * `location` venue. Performances are grouped by production id straight from the
 * listing; the detail page adds the Besetzung (`<strong>label</strong>
 * <a class="employee">name</a>` rows — creative labels + sung roles). The
 * musiktheater sparte also holds musicals → dropped via the subtitle genre.
 * Future/season-only → Wikidata backfill.
 */

const BASE = "https://www.theater-plauen-zwickau.de";
/** Theater Plauen-Zwickau on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q15452771";

interface Listed {
  title: string;
  composer: string | null;
  perfs: RawPerformance[];
}

export async function scrapeTheaterPlauenZwickau(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const byId = parseListing(await fetchHtml(`${BASE}/spielplan/`, ctx), window);
    for (const [id, p] of byId) {
      if (!p.composer || p.perfs.length === 0) continue;
      const prod: RawProduction = {
        source_production_id: id,
        work_title: p.title,
        composer_name: p.composer,
        detail_url: `${BASE}/spielplan.php?seite=0&id=${id}`,
        performances: p.perfs.sort(
          (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
        ),
      };
      try {
        const { cast, creative } = await fetchBesetzung(ctx, id);
        prod.cast = cast;
        prod.creative_team = creative;
      } catch (err) {
        console.warn(`theater-plauen-zwickau: besetzung ${id} failed:`, err);
      }
      productions.push(prod);
    }
  } catch (err) {
    console.warn("theater-plauen-zwickau: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-plauen-zwickau: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-plauen-zwickau", productions };
}

function parseListing(html: string, window: ScrapeWindow): Map<string, Listed> {
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map<string, Listed>();

  for (const chunk of html.split("data-sponsor-chunk=").slice(1)) {
    const cls = chunk.match(/class="event ([^"]*)"/)?.[1] ?? "";
    if (!/\bmusiktheater\b/.test(cls)) continue;
    const id = chunk.match(/spielplan\.php\?seite=0&(?:amp;)?id=(\d+)/)?.[1];
    const dmy = chunk.match(/complete_date hidden">(\d{2})\.(\d{2})\.(\d{4})</);
    if (!id || !dmy) continue;
    const date = `${dmy[3]}-${dmy[2]}-${dmy[1]}` as IsoDate;
    if (window.since && date < window.since) continue;

    let entry = byId.get(id);
    if (!entry) {
      const titleHtml = chunk.match(/class="title[^"]*"[^>]*>([\s\S]*?)<div class="subtitle/)?.[1];
      const subtitle = stripHtml(chunk.match(/class="subtitle[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? "");
      // The musiktheater sparte includes musicals — keep opera/operetta only.
      entry = {
        title: stripHtml(titleHtml ?? ""),
        composer: /\bmusical\b/i.test(subtitle) ? null : composerFromText(subtitle),
        perfs: [],
      };
      byId.set(id, entry);
    }
    const time = chunk.match(/(\d{1,2}:\d{2})\s*Uhr/)?.[1] ?? null;
    const venue =
      stripHtml(chunk.match(/class="location[^"]*mobile[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? "") ||
      null;
    if (!entry.perfs.some((p) => p.date === date && p.time === time)) {
      entry.perfs.push({
        date,
        time,
        venue_room: venue,
        status: date < today ? "past" : "scheduled",
      });
    }
  }
  return byId;
}

/** Detail `<h2>Besetzung</h2>` block: `<strong>label</strong>` followed by one or
 *  more `<a class="employee">name</a>`. A label in the German credit map is a
 *  creative function, anything else a sung role. */
async function fetchBesetzung(
  ctx: FetchContext,
  id: string,
): Promise<{ cast: RawCredit[]; creative: RawCredit[] }> {
  const html = await fetchHtml(`${BASE}/spielplan.php?seite=0&id=${id}`, ctx);
  const section =
    html.match(/<h2[^>]*>\s*Besetzung\s*<\/h2>([\s\S]*?)(?:<h2|<footer|$)/)?.[1] ?? "";
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];

  for (const row of section.split("<strong>").slice(1)) {
    const label = stripHtml(row.match(/^([\s\S]*?)<\/strong>/)?.[1] ?? "");
    if (!label) continue;
    const names = [...row.matchAll(/<a class="employee"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
      stripHtml(m[1] ?? "").replace(/\s*\(.*?\)\s*$/, ""),
    );
    for (const name of names) {
      if (!name) continue;
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}
