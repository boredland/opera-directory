import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchRendered, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Opéra national de Paris (`render`-indexed `spielplan-html` strategy) — the
 * primary French opera+ballet company, performing at the Palais Garnier and the
 * Opéra Bastille. French-language site with an /en mirror; we read the FRENCH
 * pages so the printed credit labels map through CREDIT_LABELS below.
 *
 * The company presents opera, ballet and concerts. Genre lives in the URL space
 * (`/saison-{YY-YY}/{opera|ballet|concerts-and-recitals}/{slug}`), so we keep
 * only the `/opera/` slugs; the composer gate (the "Musique" credit) drops the
 * stray non-opera that slips through (workshops, public classes).
 *
 * Two reads:
 *   - The season programme index is client-rendered (the static HTML lists a
 *     single show), so we RENDER `/programmation/saison-{YY-YY}` once per season
 *     and harvest the `/saison-{YY-YY}/opera/{slug}` hrefs. Seasons themselves
 *     are discovered from `/programmation`.
 *   - Each detail page is server-rendered and plain-fetchable (FR). It carries:
 *       · one schema.org `MusicEvent` object in a `<script id="microDataBase"
 *         type="application/json">` tag (NOT an `ld+json` script) — `name`,
 *         `genre`, `startDate`/`endDate` (the run span), `location.name` (Palais
 *         Garnier vs Opéra Bastille), `image`, `description`, `performer.name[]`.
 *       · a `team-list` block of `{name, role}` pairs that interleaves the
 *         creative team AND the sung cast. The composer is the item whose role is
 *         "Musique"; mapped roles become creative team; the rest are sung roles.
 *
 * Performance dates: the site exposes only the run's `startDate`/`endDate` in the
 * page (individual nights live behind the Secutix billetterie API, which 403s a
 * datacenter fetch). We emit the two run-boundary dates (deduped) as the dated
 * performances — faithful to what the page publishes — and `backfill` appends
 * Wikidata for the deep past.
 */

const BASE = "https://www.operadeparis.fr";
/** Opéra national de Paris on Wikidata — the COMPANY (Q283339, "Paris Opera",
 *  "primary opera and ballet company of France", alias "Opéra national de
 *  Paris"), NOT the Opéra Bastille building (Q638423) or the Palais Garnier.
 *  Verified via wbsearchentities (search="Opéra national de Paris", fr). */
const WIKIDATA_QID = "Q283339";

/** French `team-list__item-role` labels → our canonical function slugs. Compound
 *  labels ("Décors et costumes", "Mise en scène, décors, costumes, vidéo") are
 *  split on commas / " et " and each segment mapped, so one credited person can
 *  yield several functions. An unmapped label is treated as a sung role (cast),
 *  unless it's the composer/librettist handled separately. */
const CREDIT_LABELS: Record<string, string> = {
  "direction musicale": "conductor",
  "mise en scène": "director",
  "mise en scene": "director",
  décors: "set-designer",
  decors: "set-designer",
  scénographie: "set-designer",
  scenographie: "set-designer",
  costumes: "costume-designer",
  lumières: "lighting",
  lumieres: "lighting",
  éclairages: "lighting",
  eclairages: "lighting",
  chorégraphie: "choreographer",
  choregraphie: "choreographer",
  chorégraphe: "choreographer",
  choregraphe: "choreographer",
  dramaturgie: "dramaturgy",
  vidéo: "video-designer",
  video: "video-designer",
  "chef des chœurs": "chorus-master",
  "cheffe des chœurs": "chorus-master",
  "chef des choeurs": "chorus-master",
  "cheffe des choeurs": "chorus-master",
  "direction des chœurs": "chorus-master",
  "direction des choeurs": "chorus-master",
  "chef de chœur": "chorus-master",
  "chef de choeur": "chorus-master",
};

/** The composer credit label (verbatim on the FR page). */
const COMPOSER_LABEL = "musique";
/** Non-sung credit labels that are neither a mapped creative function nor a
 *  character — kept out of the cast list. */
const NON_CAST_LABELS = new Set(["livret", "musique", "d'après", "dapres"]);

export async function scrapeOperaNationalDeParis(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const { season, slug } of await collectOperaShows(ctx)) {
      try {
        const prod = await buildProduction(ctx, season, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`opera-national-de-paris: opera ${season}/${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("opera-national-de-paris: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opera-national-de-paris: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "opera-national-de-paris", productions };
}

interface ShowRef {
  season: string;
  slug: string;
}

/** Discover the announced seasons from `/programmation`, then render each
 *  season's programme page and harvest its `/opera/{slug}` links (the index is
 *  client-rendered, so a plain fetch sees only one show). */
async function collectOperaShows(ctx: FetchContext): Promise<ShowRef[]> {
  const seasons = await collectSeasons(ctx);
  const shows = new Map<string, ShowRef>();
  for (const season of seasons) {
    try {
      const html = await fetchRendered(`${BASE}/programmation/saison-${season}`, ctx, {
        waitMs: 6000,
      });
      const re = new RegExp(`/saison-${season}/opera/([a-z0-9-]+)`, "g");
      for (const [, slug] of html.matchAll(re)) {
        if (slug) shows.set(`${season}/${slug}`, { season, slug });
      }
    } catch (err) {
      console.warn(`opera-national-de-paris: season ${season} index failed:`, err);
    }
  }
  return [...shows.values()];
}

/** The announced seasons (e.g. "25-26", "26-27") linked from the programme hub. */
async function collectSeasons(ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(`${BASE}/programmation`, ctx);
  const seasons = new Set<string>();
  for (const [, s] of html.matchAll(/saison-(\d{2}-\d{2})/g)) if (s) seasons.add(s);
  return [...seasons];
}

interface MusicEvent {
  name?: string;
  genre?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  image?: string;
  location?: { name?: string };
}

async function buildProduction(
  ctx: FetchContext,
  season: string,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/saison-${season}/opera/${slug}`;
  const html = await fetchHtml(detailUrl, ctx);

  const event = musicEventNode(html);
  // Only stage operas; the URL space already filters, this drops a misfiled show.
  if (event?.genre && !/opera|opéra/i.test(event.genre)) return null;

  const { composer, creative_team, cast } = parseTeam(html);
  // No composer ⇒ not a staged opera (workshop / public class). The opera gate.
  if (!composer) return null;

  const title = stripHtml(event?.name ?? "") || slugToTitle(slug);
  if (!title) return null;

  const performances = parsePerformances(event, window);
  if (performances.length === 0) return null;

  return {
    source_production_id: `opera-national-de-paris/${season}/${slug}`,
    work_title: title,
    composer_name: composer,
    premiere_season: `20${season.replace("-", "/20")}`,
    detail_url: detailUrl,
    image_url: event?.image ?? null,
    synopsis: event?.description ? stripHtml(event.description) : null,
    creative_team,
    cast,
    performances,
  };
}

/** The `MusicEvent` object lives in the `microDataBase` JSON script (the page's
 *  `ld+json` script is only a `WebPage` stub). */
function musicEventNode(html: string): MusicEvent | null {
  const raw = html.match(/<script id="microDataBase"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.trim()) as MusicEvent & { "@type"?: string };
    if (parsed["@type"] === "MusicEvent" || parsed["@type"] === "TheaterEvent") return parsed;
  } catch {
    // Malformed blob.
  }
  return null;
}

/** Walk the `team-list` `{name, role}` pairs. The "Musique" item is the composer;
 *  mapped roles become creative team (compound labels split + mapped per segment);
 *  any remaining label is a sung character → cast. */
function parseTeam(html: string): {
  composer: string | null;
  creative_team: RawCredit[];
  cast: RawCredit[];
} {
  let composer: string | null = null;
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, rawName, rawRole] of html.matchAll(
    /team-list__item-name">([^<]*)<\/span>\s*(?:<\/a>)?\s*<span class="team-list__item-role">([^<]*)</g,
  )) {
    const name = stripHtml(decodeEntities(rawName ?? ""));
    const roleRaw = stripHtml(decodeEntities(rawRole ?? ""));
    if (!name || !roleRaw) continue;
    const roleKey = roleRaw.toLowerCase();

    if (roleKey === COMPOSER_LABEL) {
      if (!composer) composer = name;
      continue;
    }

    const fns = mapCreativeLabel(roleKey);
    if (fns.length > 0) {
      for (const fn of fns) {
        const key = `${fn}|${name}`;
        if (seenCreative.has(key)) continue;
        seenCreative.add(key);
        creative_team.push({ function: fn, name });
      }
      continue;
    }

    if (NON_CAST_LABELS.has(roleKey)) continue;
    const key = `${roleRaw}|${name}`;
    if (seenCast.has(key)) continue;
    seenCast.add(key);
    cast.push({ role: roleRaw, name });
  }

  return { composer, creative_team, cast };
}

/** Split a (possibly compound) French role label into mapped function slugs. */
function mapCreativeLabel(roleKey: string): string[] {
  const direct = CREDIT_LABELS[roleKey];
  if (direct) return [direct];
  const fns = new Set<string>();
  for (const seg of roleKey.split(/\s*(?:,|\bet\b|&)\s*/)) {
    const fn = CREDIT_LABELS[seg.trim()];
    if (fn) fns.add(fn);
  }
  return [...fns];
}

/** The page publishes the run span (`startDate`/`endDate`), not per-night dates
 *  (those sit behind the Secutix billetterie API). Emit the run-boundary dates
 *  (deduped) with the production's venue. Honors window.since. */
function parsePerformances(event: MusicEvent | null, window: ScrapeWindow): RawPerformance[] {
  if (!event) return [];
  const venue = event.location?.name ? stripHtml(event.location.name) : null;
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const raw of [event.startDate, event.endDate]) {
    const date = (raw ?? "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1] as IsoDate | undefined;
    if (!date) continue;
    if (window.since && date < window.since) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, venue_room: venue, status: date < today ? "past" : "scheduled" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/-\d+$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
