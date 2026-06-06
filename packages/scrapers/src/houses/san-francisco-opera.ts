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

/**
 * San Francisco Opera (`jsonld-event` strategy) — a Tier-1 US opera company
 * (US/English) staging a year-round season (fall + a June summer season) in the
 * War Memorial Opera House. SF Opera ticketing is Tessitura, but no public
 * Tessitura/TNEW endpoint is exposed: production metadata lives entirely in one
 * schema.org `EventSeries` JSON-LD blob on each marketing-site production page,
 * so the live scrape reads that and `backfill` appends Wikidata for the deep past.
 *
 * The season index `/buy-tickets/` links each staged opera as `/operas/{slug}/`
 * (concerts/galas/recitals live under `/seasons/` and carry no JSON-LD — out of
 * scope by construction). Each `/operas/{slug}/` page carries one `EventSeries`
 * node where everything we need is pre-structured:
 *   - `workPerformed.creator[0]` — the composer (Person). Required; a package
 *     page like `ring-cycle` has no JSON-LD and is dropped here.
 *   - `performer[]` — `PerformanceRole` cast (`characterName` + Person), `roleName`
 *     "Singer".
 *   - `contributor[]` — `Role` creative team; `roleName` is the ENGLISH function
 *     label, mapped to our slugs INSIDE this adapter (see CREATIVE_FUNCTIONS).
 *   - `subEvent[]` — `PerformingArtsEvent` per night (`startDate` local ISO,
 *     `eventStatus`); `inLanguage` and `location.name` (the War Memorial Opera
 *     House) round it out.
 */

const BASE = "https://www.sfopera.com";
/** San Francisco Opera on Wikidata — the opera COMPANY (Q390354), not the
 *  War Memorial Opera House building, the Opera Center (Q6819926), or the
 *  Association record (Q135486841). Verified via wbsearchentities: Q390354 =
 *  "San Francisco Opera", description "opera company in San Francisco,
 *  California, United States". */
const WIKIDATA_QID = "Q390354";

/** English `contributor.roleName` labels → our canonical function slugs. SF Opera
 *  prints original/revival/associate variants and some unmodeled labels (e.g.
 *  "Production", "Original Projections") — folded or dropped here so ingest sees a
 *  stable function. An unmapped label is dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  director: "director",
  "stage director": "director",
  "original director": "director",
  "revival director": "director",
  "associate director": "director",
  "associate director and choreographer": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "set and projection designer": "set-designer",
  "production designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "original lighting designer": "lighting",
  "revival lighting designer": "lighting",
  "projection designer": "video-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "chorus director": "chorus-master",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeSanFranciscoOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectOperaSlugs(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}/operas/${slug}/`, ctx), slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`san-francisco-opera: opera ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("san-francisco-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("san-francisco-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "san-francisco-opera", productions };
}

/** Collect unique `/operas/{slug}/` slugs from the season index. The homepage and
 *  `/buy-tickets/` both list the running and already-announced seasons; package
 *  pages (e.g. `ring-cycle`) slip in but carry no JSON-LD and drop out downstream. */
async function collectOperaSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  for (const path of ["/buy-tickets/", "/"]) {
    try {
      const html = await fetchHtml(`${BASE}${path}`, ctx);
      for (const [, slug] of html.matchAll(/href="\/operas\/([^"/#]+)\//g)) {
        if (slug) slugs.add(slug);
      }
    } catch (err) {
      console.warn(`san-francisco-opera: index ${path} failed:`, err);
    }
  }
  return [...slugs];
}

interface LdPerson {
  name?: string;
  url?: string;
}
interface LdContributor {
  contributor?: LdPerson;
  roleName?: string;
}
interface LdPerformer {
  performer?: LdPerson;
  characterName?: string;
  roleName?: string;
}
interface LdSubEvent {
  startDate?: string;
  eventStatus?: string;
}
interface LdEventSeries {
  "@type"?: string;
  name?: string;
  inLanguage?: string;
  image?: string;
  description?: string;
  workPerformed?: { creator?: LdPerson | LdPerson[] };
  performer?: LdPerformer | LdPerformer[];
  contributor?: LdContributor | LdContributor[];
  subEvent?: LdSubEvent | LdSubEvent[];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const node = eventSeriesNode(html);
  if (!node) return null;

  const composer = composerOf(node);
  // No composer ⇒ a package/non-opera page that slipped past the /operas/ scope.
  if (!composer) return null;

  const performances = parsePerformances(node, window);
  if (performances.length === 0) return null;

  const title =
    stripHtml(node.name ?? "") ||
    stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "") ||
    slugToTitle(slug);
  if (!title) return null;

  return {
    source_production_id: `san-francisco-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(node.inLanguage),
    detail_url: `${BASE}/operas/${slug}/`,
    image_url: node.image ?? null,
    synopsis: node.description ? stripHtml(node.description) : null,
    creative_team: parseCreative(node),
    cast: parseCast(node),
    performances,
  };
}

/** The single `EventSeries` JSON-LD blob on a production page. */
function eventSeriesNode(html: string): LdEventSeries | null {
  for (const m of html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    try {
      const parsed = JSON.parse((m[1] ?? "").trim()) as LdEventSeries;
      if (parsed && parsed["@type"] === "EventSeries") return parsed;
    } catch {
      // Malformed blob — try the next one.
    }
  }
  return null;
}

/** The composer is the first `workPerformed.creator` (librettists follow). */
function composerOf(node: LdEventSeries): string | null {
  const creator = node.workPerformed?.creator;
  const first = Array.isArray(creator) ? creator[0] : creator;
  const name = stripHtml(first?.name ?? "");
  return name || null;
}

function parseCast(node: LdEventSeries): RawCredit[] {
  const performers = Array.isArray(node.performer)
    ? node.performer
    : node.performer
      ? [node.performer]
      : [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const p of performers) {
    const name = stripHtml(p.performer?.name ?? "");
    const role = stripHtml(p.characterName ?? "");
    if (!name || !role) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cast.push({ role, name });
  }
  return cast;
}

function parseCreative(node: LdEventSeries): RawCredit[] {
  const contributors = Array.isArray(node.contributor)
    ? node.contributor
    : node.contributor
      ? [node.contributor]
      : [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();
  for (const c of contributors) {
    const name = stripHtml(c.contributor?.name ?? "");
    const fn = CREATIVE_FUNCTIONS[stripHtml(c.roleName ?? "").toLowerCase()];
    if (!name || !fn) continue;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creative.push({ function: fn, name });
  }
  return creative;
}

/** Performances are the `subEvent[]` nights (`startDate` local ISO, `eventStatus`),
 *  all in the War Memorial Opera House. Honors window.since. */
function parsePerformances(node: LdEventSeries, window: ScrapeWindow): RawPerformance[] {
  const subs = Array.isArray(node.subEvent) ? node.subEvent : node.subEvent ? [node.subEvent] : [];
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const sub of subs) {
    const m = (sub.startDate ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
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
      status: eventStatus(sub.eventStatus, date, today),
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

const VENUE = "War Memorial Opera House";

function eventStatus(status: unknown, date: IsoDate, today: string): RawPerformance["status"] {
  if (typeof status === "string" && /EventCancelled/i.test(status)) return "cancelled";
  return date < today ? "past" : "scheduled";
}

function languageCode(inLanguage: string | undefined): RawProduction["language"] {
  if (!inLanguage) return null;
  const code = inLanguage.trim().slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? (code as RawProduction["language"]) : null;
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
