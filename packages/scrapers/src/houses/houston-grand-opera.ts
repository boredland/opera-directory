import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Houston Grand Opera (`json-api` strategy) — Tier-1 US opera company in Houston,
 * Texas (US/English), season ~Oct–May at the Wortham Theater Center. The live
 * scrape is the announced season; `backfill` appends Wikidata for the deep past.
 *
 * Next.js (Vercel) marketing site. Every production is an `/on-stage/{slug}` page
 * whose `__NEXT_DATA__` carries one `props.pageProps.onStage` object — far richer
 * than the Tessitura ticketing API (`my.houstongrandopera.org`, TNEW), so we read
 * the page state, not the API. The slug set comes from the site sitemap (more
 * complete than the live index grid). One `onStage` object yields everything:
 *   - `title`, `composer` (a plain ENGLISH name string, not the German
 *     composerFromText), `librettist`.
 *   - Performances in `_allReferencingSchedulerRightRails[]`: each `dateTime` is a
 *     local-time ISO string ("YYYY-MM-DDThh:mm:ss-06:00").
 *   - Cast + creative team in `nestedNavigations[].tabs[].artists[]`, split by the
 *     tab's `tabTitle`: the "cast" tab lists singers (role = voice Fach), the
 *     "creative" tab lists the production team (role = an ENGLISH function label,
 *     mapped to our slugs INSIDE this adapter via CREATIVE_FUNCTIONS).
 *
 * Opera filter: the season grid also carries competitions, community events and
 * studio showcases (Concert of Arias, Giving Voice, Family Day), plus stale
 * placeholder pages for past titles. A real staged production has a composer AND
 * a cast AND at least one dated performance — the combination every non-opera and
 * every empty placeholder fails. Every performance is at the Wortham Theater
 * Center, so the venue is fixed.
 */

const BASE = "https://www.houstongrandopera.org";
const SITEMAP_URL = `${BASE}/sitemap-0.xml`;
const VENUE = "Wortham Theater Center";

/** Houston Grand Opera on Wikidata — the opera COMPANY (Q1113726), not the chorus
 *  (Q133415586). Verified via wbsearchentities: Q1113726 = "Houston Grand Opera",
 *  description "opera company". */
const WIKIDATA_QID = "Q1113726";

/** English creative-team labels (the "creative" tab's `role`) → our function
 *  slugs. A creative-tab artist whose role is unmapped (or blank) is dropped
 *  rather than guessed; singers live in the separate "cast" tab. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "scenic designer": "set-designer",
  "set designer": "set-designer",
  "set and projection designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  "projection/video designer": "projection-designer",
  "projection and video designer": "projection-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus director": "chorus-master",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
};

interface OnStageArtist {
  name?: string;
  role?: string;
}

interface OnStageTab {
  tabTitle?: string;
  artists?: OnStageArtist[];
}

interface OnStageSchedule {
  dateTime?: string;
  hidden?: boolean;
}

interface OnStage {
  title?: string;
  composer?: string;
  slug?: string;
  nestedNavigations?: { tabs?: OnStageTab[] }[];
  _allReferencingSchedulerRightRails?: OnStageSchedule[];
}

export async function scrapeHoustonGrandOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectSlugs(ctx)) {
      try {
        const html = await fetchHtml(`${BASE}/on-stage/${slug}`, ctx);
        const prod = parseProduction(html, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`houston-grand-opera: on-stage ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("houston-grand-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("houston-grand-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "houston-grand-opera", productions };
}

/** Read the sitemap's `/on-stage/{slug}` entries — the complete production set
 *  (the live index grid only lists the running + next season). */
async function collectSlugs(ctx: FetchContext): Promise<string[]> {
  const xml = await fetchHtml(SITEMAP_URL, ctx);
  const slugs = new Set<string>();
  for (const [, slug] of xml.matchAll(/\/on-stage\/([^<\s/]+)</g)) {
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const o = parseOnStage(html);
  if (!o) return null;

  const composer = cleanText(o.composer);
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(o);
  // A staged production bills sung roles; the competitions / community events /
  // studio showcases sharing /on-stage carry none. This is the opera filter.
  if (cast.length === 0) return null;

  const performances = parsePerformances(o, window);
  if (performances.length === 0) return null;

  const title = cleanText(o.title);
  if (!title) return null;

  return {
    source_production_id: `houston-grand-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/on-stage/${slug}`,
    creative_team,
    cast,
    performances,
  };
}

/** Pull `props.pageProps.onStage` out of the page's `__NEXT_DATA__` JSON. */
function parseOnStage(html: string): OnStage | null {
  const raw = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  )?.[1];
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as {
      props?: { pageProps?: { onStage?: OnStage } };
    };
    return data.props?.pageProps?.onStage ?? null;
  } catch {
    return null;
  }
}

/** The "cast" tab lists singers (role = voice Fach, kept verbatim); the "creative"
 *  tab lists the production team (role = an English function label, mapped here). */
function parseCredits(o: OnStage): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const section of o.nestedNavigations ?? []) {
    for (const tab of section.tabs ?? []) {
      const kind = (tab.tabTitle ?? "").trim().toLowerCase();
      if (kind !== "cast" && kind !== "creative") continue;
      for (const artist of tab.artists ?? []) {
        const name = cleanText(artist.name);
        const role = cleanText(artist.role);
        if (!name) continue;

        if (kind === "cast") {
          const key = `cast|${role}|${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          cast.push({ role: role || null, name });
        } else {
          const fn = role && CREATIVE_FUNCTIONS[role.toLowerCase()];
          if (!fn) continue;
          const key = `${fn}|${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          creative_team.push({ function: fn, name });
        }
      }
    }
  }
  return { creative_team, cast };
}

/** Performance nights live in `_allReferencingSchedulerRightRails[]`, each a
 *  local-time ISO `dateTime`. Honors window.since; drops hidden entries. */
function parsePerformances(o: OnStage, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const item of o._allReferencingSchedulerRightRails ?? []) {
    if (item.hidden) continue;
    const m = (item.dateTime ?? "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (!m) continue;
    const date = m[1] as IsoDate;
    const time = m[2] ?? null;
    if (window.since && date < window.since) continue;

    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date,
      time,
      venue_room: VENUE,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Decode entities and collapse whitespace (incl. trailing nbsp on composer names). */
function cleanText(value: string | undefined | null): string {
  return decodeEntities(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
