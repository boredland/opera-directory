import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Opéra de Lausanne (`spielplan-html`) — the Vaud/Lausanne opera house. WordPress
 * (Bedrock), bilingual; the adapter reads the English mirror (`/en/…`) for English
 * credit labels. Plain fetch (200 to the crawler UA, no proxy), no schema.org
 * Event JSON-LD, so everything is parsed from the SSR HTML:
 *   - `/en/archives/` lists the published seasons (`/season/{YYYY-YY}/`); the site
 *     keeps only the current + next season, so there is no deep archive to walk.
 *   - Each season page links its productions at `/show/{slug}/` (alongside many
 *     ancillary pages — pre-opera talks, cinema screenings, public visits — which
 *     are skipped by slug suffix and, as a backstop, by the composer/date gate).
 *   - Show page: `<h1>` work title, `.show-hero__composer` composer ("Giuseppe
 *     Verdi (1813-1901)" → years stripped). Credits sit in two `.casting-list`
 *     blocks of alternating `.casting__role` / `.casting__name`: the FIRST block
 *     is the creative team (English function labels mapped in-adapter, unmapped
 *     crew dropped), the SECOND is the cast (character role + singer).
 *   - Performance dates: the month from `.show-hero__dates` + the day numbers from
 *     the `.date__bubble` calendar; the year is derived from the season (months
 *     Sep–Dec → the season's first year, Jan–Aug → the second).
 */

const BASE = "https://www.opera-lausanne.ch";
const ARCHIVES = `${BASE}/en/archives/`;

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** English creative-function labels (as Opéra de Lausanne prints them) → slugs. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "musical direction": "conductor",
  director: "director",
  "stage director": "director",
  staging: "director",
  "set design": "set-designer",
  "set designer": "set-designer",
  scenography: "set-designer",
  "costumes designer": "costume-designer",
  "costume designer": "costume-designer",
  costumes: "costume-designer",
  "lighting designer": "lighting",
  "lighting design": "lighting",
  lighting: "lighting",
  choreography: "choreographer",
  choreographer: "choreographer",
  "chorus master": "chorus-master",
  "choir master": "chorus-master",
  dramaturgy: "dramaturgy",
  dramaturg: "dramaturgy",
};

/** Ancillary `/show/` pages that aren't productions (talks, screenings, visits). */
const ANCILLARY_SLUG =
  /-(forum-opera|forum|cinematheque|public-visit|visit|literary-circle|tkm|collection-art-brut|conference|masterclass)$|^initiation-/;

export async function scrapeOperaDeLausanne(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  const seen = new Set<string>();

  let seasons: { slug: string; startYear: number }[] = [];
  try {
    const archives = await fetchHtml(ARCHIVES, ctx);
    const bySlug = new Map<string, number>();
    for (const m of archives.matchAll(/\/season\/(\d{4})-\d{2}\//g)) {
      bySlug.set(m[0], Number.parseInt(m[1] ?? "", 10));
    }
    seasons = [...bySlug].map(([slug, startYear]) => ({ slug, startYear }));
  } catch (err) {
    console.warn("opera-de-lausanne: archives fetch failed:", err);
    return { house_slug: "opera-de-lausanne", productions };
  }

  for (const season of seasons) {
    let showSlugs: string[] = [];
    try {
      const html = await fetchHtml(`${BASE}/en${season.slug}`, ctx);
      showSlugs = [
        ...new Set([...html.matchAll(/\/show\/([a-z0-9-]+)\//g)].map((m) => m[1] as string)),
      ];
    } catch (err) {
      console.warn(`opera-de-lausanne: season ${season.slug} failed:`, err);
      continue;
    }

    for (const slug of showSlugs) {
      if (ANCILLARY_SLUG.test(slug) || seen.has(slug)) continue;
      seen.add(slug);
      try {
        const html = await fetchHtml(`${BASE}/en/show/${slug}/`, ctx);
        const prod = parseShow(html, slug, season.startYear);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`opera-de-lausanne: show ${slug} failed:`, err);
      }
    }
  }

  return { house_slug: "opera-de-lausanne", productions };
}

function parseShow(html: string, slug: string, seasonStartYear: number): RawProduction | null {
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const composer = stripHtml(html.match(/show-hero__composer[^>]*>([\s\S]*?)<\//)?.[1] ?? "")
    .replace(/\s*\(\d{4}.*$/, "")
    .trim();
  // A person-name composer + a cast list gate out recitals (composer = a voice
  // type like "Baryton"), singing competitions, and dance evenings.
  if (!title || !isPersonName(composer)) return null;

  const performances = parsePerformances(html, seasonStartYear);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCasting(html);
  if (cast.length === 0) return null;

  return {
    source_production_id: `opera-de-lausanne/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/en/show/${slug}/`,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances,
  };
}

const NAME_PARTICLES = new Set(["von", "van", "de", "da", "di", "del", "der", "le", "la", "y"]);

/** A composer byline reads as a person name (rejects "Baryton", competition and
 *  dance-evening labels in the composer slot). */
function isPersonName(text: string): boolean {
  if (!text || /^\d/.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length < 1 || words.length > 5) return false;
  return words.every((w) => {
    const bare = w.replace(/[.'’-]/g, "");
    if (!bare) return true;
    if (NAME_PARTICLES.has(bare.toLowerCase())) return true;
    return /^\p{Lu}/u.test(bare);
  });
}

function ogImage(html: string): string | null {
  return (
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1] ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)?.[1] ??
    null
  );
}

const CREW_LABEL =
  /\b(assistant|collaboration|direction|designer|design|scenograph|dramaturg|staging|violin|harpsichord|continuo|repetiteur|répétiteur|chef|chorus|choir|light|sound|video|translation|surtitle|orchestra|ensemble|master|maestro)\b/i;

/** Pair the page's `.casting__role` / `.casting__name` entries (they alternate one
 *  role + one name per credit) and classify each: a mapped function → creative
 *  team; an empty or crew-ish label → dropped (unmapped crew like "Collaboration
 *  on the staging" / "Director and violin"); anything else → a cast role. Doing
 *  this per-pair (not per `.casting-list` block) handles both the standard layout
 *  and the concert-style pages that fold cast and crew into one block. */
function parseCasting(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const roles = [...html.matchAll(/casting__role[^>]*>([\s\S]*?)<\//g)].map((m) =>
    stripHtml(m[1] ?? ""),
  );
  const names = [...html.matchAll(/casting__name[^>]*>([\s\S]*?)<\//g)].map((m) =>
    stripHtml(m[1] ?? ""),
  );
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  for (let i = 0; i < Math.min(roles.length, names.length); i++) {
    const role = roles[i] ?? "";
    const name = names[i] ?? "";
    if (!name) continue;
    const fn = CREATIVE_FUNCTIONS[role.toLowerCase()];
    if (fn) creative_team.push({ function: fn, name });
    else if (role && !CREW_LABEL.test(role)) cast.push({ role, name });
  }
  return { creative_team, cast };
}

/** Month from `.show-hero__dates` + day numbers from `.date__bubble`, dated by the
 *  season (Sep–Dec → first season year, Jan–Aug → second). */
function parsePerformances(html: string, seasonStartYear: number): RawPerformance[] {
  const datesText = stripHtml(html.match(/show-hero__dates[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
  const month = MONTHS[datesText.slice(0, 3).toLowerCase()];
  if (!month) return [];
  const year = month >= 9 ? seasonStartYear : seasonStartYear + 1;

  const days = [
    ...new Set(
      [...html.matchAll(/date__bubble[^>]*>\s*(\d{1,2})\s*</g)].map((m) =>
        Number.parseInt(m[1] ?? "", 10),
      ),
    ),
  ].filter((d) => d >= 1 && d <= 31);

  const today = new Date().toISOString().slice(0, 10);
  return days
    .map((day) => {
      const date =
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as IsoDate;
      return { date, status: (date < today ? "past" : "scheduled") as RawPerformance["status"] };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
