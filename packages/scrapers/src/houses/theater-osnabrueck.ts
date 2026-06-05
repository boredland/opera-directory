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
 * Theater Osnabrück (`spielplan-html`, server-rendered, no proxy).
 *
 * /spielplan/ is one page holding the whole season as `mod-teaser--kalender`
 * blocks, one per performance, with everything in `data-sp-*` attributes:
 * `data-sp-sparte` (Oper/Operette = opera), `data-sp-stueck` (title), `data-sp-day`
 * (DD-MM-YYYY), `data-sp-ort` (venue) + a "{genre} von {Composer}" `<h3>` and a
 * "Beginn: HH:MM" time. Performances are grouped into productions by the numeric
 * id in their `/veranstaltung/{slug}/{id}/{perfId}` detail link; that detail page's
 * "Team & Besetzung" accordion gives the cast + creative team as "Label: Name"
 * pairs. Future/season-only → Wikidata backfill for history.
 */

const BASE = "https://www.theater-osnabrueck.de";
/** Theater Osnabrück on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415927";
/** Besetzung labels that are work credits, not cast or creative team. */
const SKIP_LABELS = new Set(["komponist", "libretto", "text", "musik", "nach"]);

interface Teaser {
  prodId: string;
  title: string;
  composer: string | null;
  detailUrl: string;
  perf: RawPerformance;
}

export async function scrapeTheaterOsnabrueck(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const grouped = groupTeasers(parseListing(await fetchHtml(`${BASE}/spielplan/`, ctx), window));
    for (const prod of grouped) {
      try {
        const { cast, creative } = await fetchCredits(ctx, prod.detail_url ?? "");
        prod.cast = cast;
        prod.creative_team = creative;
      } catch (err) {
        console.warn(`theater-osnabrueck: credits ${prod.source_production_id} failed:`, err);
      }
      productions.push(prod);
    }
  } catch (err) {
    console.warn("theater-osnabrueck: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-osnabrueck: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-osnabrueck", productions };
}

function parseListing(html: string, window: ScrapeWindow): Teaser[] {
  const today = new Date().toISOString().slice(0, 10);
  const teasers: Teaser[] = [];

  for (const m of html.matchAll(
    /(<div class="[^"]*mod-teaser--kalender"[^>]*>)([\s\S]*?)(?=<div class="[^"]*mod-teaser--kalender"|<\/main|<footer)/g,
  )) {
    const tag = m[1] ?? "";
    const body = m[2] ?? "";
    const sparte = tag.match(/data-sp-sparte="([^"]*)"/)?.[1];
    if (sparte !== "Oper" && sparte !== "Operette") continue;

    const dmy = tag.match(/data-sp-day="(\d{2})-(\d{2})-(\d{4})"/);
    const detail = body.match(/href="(\/veranstaltung\/[^"]+)"/)?.[1];
    if (!dmy || !detail) continue;
    const prodId = detail.match(/\/veranstaltung\/[^/]+\/(\d+)/)?.[1];
    if (!prodId) continue;

    const date = `${dmy[3]}-${dmy[2]}-${dmy[1]}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = body.match(/Beginn:\s*(\d{1,2}:\d{2})/)?.[1] ?? null;

    teasers.push({
      prodId,
      title: stripHtml(tag.match(/data-sp-stueck="([^"]*)"/)?.[1] ?? ""),
      composer: composerFromText(stripHtml(body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "")),
      detailUrl: `${BASE}${detail}`,
      perf: {
        date,
        time,
        venue_room: stripHtml(tag.match(/data-sp-ort="([^"]*)"/)?.[1] ?? "") || null,
        status: date < today ? "past" : "scheduled",
      },
    });
  }
  return teasers;
}

function groupTeasers(teasers: Teaser[]): RawProduction[] {
  const byId = new Map<string, RawProduction>();
  for (const t of teasers) {
    // A gala / special event has no "{genre} von {composer}" line — skip it.
    if (!t.title || !t.composer) continue;
    let prod = byId.get(t.prodId);
    if (!prod) {
      prod = {
        source_production_id: `os-${t.prodId}`,
        work_title: t.title,
        composer_name: t.composer,
        detail_url: t.detailUrl,
        performances: [],
      };
      byId.set(t.prodId, prod);
    }
    prod.performances.push(t.perf);
  }
  for (const prod of byId.values()) {
    prod.performances.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
  }
  return [...byId.values()];
}

/** The "Team & Besetzung" accordion lists "Label: Name" lines: a label in the
 *  German credit map is a creative function, a work-credit label is skipped, and
 *  anything else (a character name) is a sung role. */
async function fetchCredits(
  ctx: FetchContext,
  detailUrl: string,
): Promise<{ cast: RawCredit[]; creative: RawCredit[] }> {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  if (!detailUrl) return { cast, creative };

  const html = await fetchHtml(detailUrl, ctx);
  const block =
    html.match(/Besetzung<\/button>\s*<div[^>]*toggleContainer[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  for (const p of block.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    for (const line of (p[1] ?? "").split(/<br\s*\/?>/)) {
      const text = stripHtml(line);
      const sep = text.indexOf(":");
      if (sep < 1) continue;
      const label = text.slice(0, sep).trim();
      const name = text.slice(sep + 1).trim();
      if (!name || SKIP_LABELS.has(label.toLowerCase())) continue;
      const credit = normalizeGermanCredit(label, name);
      if (credit.function) creative.push(credit);
      else cast.push(credit);
    }
  }
  return { cast, creative };
}
