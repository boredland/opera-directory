import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, renderHtml, stripHtml } from "../fetch";
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
 * Staatsoper Stuttgart (`render` strategy).
 *
 * The kalender is fully client-rendered with no JSON API or inline state, so
 * this adapter uses the headless renderer (see fetch.ts `renderHtml`). The
 * rendered kalender lists performance links `/spielplan/kalender/{slug}/{id}/`
 * (one per night); each rendered detail page puts the work + composer + date in
 * its `<title>` ("Title, von Composer - DD.MM.YYYY, HH:MM | …") and the cast +
 * creative team as one "Rolle: Name, … , Musikalische Leitung: Name, …" run.
 * We render every performance page (its own date), grouping by slug into one
 * production. Future-only → deep history from Wikidata in backfill.
 */

const BASE = "https://www.staatsoper-stuttgart.de";
const KALENDER = `${BASE}/spielplan/kalender/`;
/** Staatsoper Stuttgart (the house) on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q467147";

export async function scrapeStaatsoperStuttgart(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const listing = await renderHtml(KALENDER, ctx, {
    waitForSelector: ".performance__mainrow",
    waitMs: 2500,
  });
  const links = [...new Set(listing.match(/\/spielplan\/kalender\/[a-z0-9-]+\/\d+\//g) ?? [])];

  const byProduction = new Map<string, RawProduction>();
  const today = new Date().toISOString().slice(0, 10);
  for (const path of links) {
    try {
      const detail = await renderHtml(`${BASE}${path}`, ctx, {
        waitForSelector: "title",
        waitMs: 800,
      });
      const parsed = parseDetail(detail);
      if (!parsed) continue;
      if (window.since && parsed.date < window.since) continue;

      const slug = path.split("/")[3] ?? path;
      const existing = byProduction.get(slug);
      const performance: RawPerformance = {
        date: parsed.date,
        time: parsed.time,
        status: parsed.date < today ? "past" : "scheduled",
      };
      if (existing) {
        existing.performances.push(performance);
      } else {
        byProduction.set(slug, {
          source_production_id: slug,
          work_title: parsed.title,
          composer_name: parsed.composer,
          detail_url: `${BASE}${path}`,
          creative_team: parsed.creative_team,
          cast: parsed.cast,
          performances: [performance],
        });
      }
    } catch (err) {
      console.warn(`staatsoper-stuttgart: ${path} failed:`, err);
    }
  }

  const productions = [...byProduction.values()];
  for (const p of productions) {
    p.performances.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatsoper-stuttgart: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatsoper-stuttgart", productions };
}

interface DetailParse {
  title: string;
  composer: string | null;
  date: IsoDate;
  time: string | null;
  creative_team: RawCredit[];
  cast: RawCredit[];
}

/** `<title>` = "Title, von Composer - DD.MM.YYYY, HH:MM – HH:MM | Staatsoper Stuttgart". */
function parseDetail(html: string): DetailParse | null {
  const title = stripHtml(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
  const m = title.match(
    /^(.*?)(?:,\s*von\s+(.*?))?\s*-\s*(\d{2})\.(\d{2})\.(\d{4})(?:,\s*(\d{1,2}:\d{2}))?/,
  );
  if (!m) return null;
  const date = `${m[5]}-${m[4]}-${m[3]}` as IsoDate;
  const { creative_team, cast } = parseCredits(html);
  return {
    title: (m[1] ?? "").trim(),
    composer: m[2]?.trim() || null,
    date,
    time: m[6] ?? null,
    creative_team,
    cast,
  };
}

/**
 * The full cast + creative live in a `<meta>` description as one
 * "Rolle: Name, …, Musikalische Leitung: Name, …" run. Parse that: each
 * comma-segment is "Label: Name" (a section header like "Besetzung:" can prefix
 * the first role, so take the last two colon-parts); German function labels →
 * creative team, everything else is a sung role. Skip the prose (von/Libretto/…).
 */
const SKIP_CREDIT = /recherche|mitarbeit|basis|interview|libretto|nach\b|\bvon\b/i;

function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const meta = html.match(/content="([^"]*(?:Musikalische Leitung|Regie):[^"]*)"/)?.[1];
  if (!meta) return { creative_team, cast };

  const seen = new Set<string>();
  for (const segment of decodeEntities(meta).split(/,\s*/)) {
    const parts = segment.split(":");
    if (parts.length < 2) continue;
    const name = (parts.at(-1) ?? "").trim();
    const role = (parts.at(-2) ?? "").trim();
    if (!role || !name || name.length > 60 || SKIP_CREDIT.test(role)) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const credit = normalizeGermanCredit(role, name);
    if (credit.function) creative_team.push(credit);
    else cast.push(credit);
  }
  return { creative_team, cast };
}
