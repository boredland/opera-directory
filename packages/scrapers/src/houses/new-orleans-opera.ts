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

/**
 * New Orleans Opera Association (`jsonld-event` strategy) — the regional opera
 * company of New Orleans, Louisiana, USA, staging its mainstage season in the
 * Mahalia Jackson Theater for the Performing Arts. The live scrape reads
 * schema.org `Event` JSON-LD off the season pages; `backfill` appends Wikidata
 * for the deep past (e.g. the 1966 world premiere of Floyd's *Markheim*).
 *
 * The company is mid-rebrand: the site moved off WordPress onto Squarespace and,
 * at time of writing, the new build is a placeholder (Home/About/Mission/Staff/
 * Contact only) with no season collection published yet. The live leg therefore
 * yields nothing today — by design it degrades to empty rather than failing.
 * When the season relaunches as a Squarespace Events collection it will emit the
 * usual schema.org `Event` markup, which this adapter already parses:
 *   - composer: schema.org has no composer field, so we read it from the page
 *     text via the "Composer:" / "Music by" / "by {Name}" line in the event
 *     description — an ENGLISH structured cue. REQUIRED (the opera gate): a gala,
 *     recital, a Messiah or Requiem concert, or an Opera-on-Tap night exposes no
 *     composer line and is dropped.
 *   - cast/creative: schema.org `performer[]` — when typed `PerformanceRole` the
 *     `roleName` is the sung character (cast); a plain Person performer with a
 *     recognized ENGLISH function label (Conductor/Director/…) maps to creative
 *     via CREATIVE_FUNCTIONS (in-adapter). Unmapped labels are dropped.
 *   - performances: each Event's `startDate` (local ISO), `eventStatus`, and
 *     `location.name` (the Mahalia Jackson Theater). Events sharing a work_title
 *     are regrouped into one production.
 *
 * Discovery: the live leg walks the Squarespace XML sitemap (the site's
 * authoritative page list) and extracts the JSON-LD Events present on each page.
 * No remote-JS eval; plain fetch + regex/JSON only.
 */

const BASE = "https://www.neworleansopera.org";

/** New Orleans Opera on Wikidata — the opera COMPANY (Q7010759, P31 = opera
 *  company Q153562, headquartered in New Orleans Q34404, official website
 *  neworleansopera.org), NOT the legal-entity record "New Orleans Opera
 *  Association" (Q54816128, P31 = nonprofit organization). Verified via
 *  wbsearchentities + wbgetentities P31/P159/P856. */
const WIKIDATA_QID = "Q7010759";

const VENUE = "Mahalia Jackson Theater for the Performing Arts";

/** English performer/creative function labels → our canonical function slugs.
 *  Assistant/associate/revival variants fold onto the principal function;
 *  unmapped labels (Wig/Makeup/Fight Director, etc.) are dropped, not guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "musical director": "conductor",
  director: "director",
  "stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeNewOrleansOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const byWork = new Map<string, RawProduction>();
    for (const url of await collectPageUrls(ctx)) {
      try {
        const html = await fetchHtml(url, ctx);
        for (const event of extractEventJsonLd(html)) collectEvent(event, url, window, byWork);
      } catch (err) {
        console.warn(`new-orleans-opera: page ${url} failed:`, err);
      }
    }
    for (const prod of byWork.values()) {
      prod.performances.sort(
        (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
      );
      if (prod.performances.length > 0) productions.push(prod);
    }
  } catch (err) {
    console.warn("new-orleans-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("new-orleans-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "new-orleans-opera", productions };
}

/** Discover candidate pages from the Squarespace XML sitemap — its authoritative
 *  page list, so the season collection appears here automatically once published.
 *  Pages with no Event JSON-LD simply contribute nothing. */
async function collectPageUrls(ctx: FetchContext): Promise<string[]> {
  const urls = new Set<string>();
  try {
    const xml = await fetchHtml(`${BASE}/sitemap.xml`, ctx);
    for (const [, loc] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      if (loc) urls.add(loc.trim());
    }
  } catch (err) {
    console.warn("new-orleans-opera: sitemap failed:", err);
  }
  return [...urls];
}

interface LdPerformer {
  "@type"?: string | string[];
  name?: string;
  roleName?: string;
  characterName?: string;
  performer?: { name?: string };
}

/** Fold one JSON-LD Event into the production it belongs to (keyed by work_title).
 *  REQUIRES a composer (the opera gate); honors window.since on the performance date. */
function collectEvent(
  event: Record<string, unknown>,
  pageUrl: string,
  window: ScrapeWindow,
  byWork: Map<string, RawProduction>,
): void {
  const title = stripHtml(asText(event.name));
  if (!title) return;

  const composer = composerFromEvent(event);
  if (!composer) return;

  const perf = parsePerformance(event);
  if (!perf) return;
  if (window.since && perf.date < window.since) return;

  const key = title.toLowerCase();
  let prod = byWork.get(key);
  if (!prod) {
    const { creative_team, cast } = parseCredits(event);
    prod = {
      source_production_id: `new-orleans-opera/${slugify(title)}`,
      work_title: title,
      composer_name: composer,
      language: languageCode(asText(event.inLanguage)),
      detail_url: asText((event as { url?: unknown }).url) || pageUrl,
      image_url: asText(event.image) || null,
      synopsis: event.description ? stripHtml(asText(event.description)) : null,
      creative_team,
      cast,
      performances: [],
    };
    byWork.set(key, prod);
  }

  const dupe = prod.performances.some((p) => p.date === perf.date && p.time === perf.time);
  if (!dupe) prod.performances.push(perf);
}

/** schema.org carries no composer field; read it from the event description /
 *  name text ("Composer: X", "Music by X", "X's {opera}", "by X"). */
function composerFromEvent(event: Record<string, unknown>): string | null {
  const text = `${stripHtml(asText(event.description))} ${stripHtml(asText(event.name))}`;
  const patterns = [
    /Composer[s]?\s*:\s*([A-Z][\p{L}.'-]+(?:\s+[A-Z][\p{L}.'-]+){1,3})/u,
    /Music\s+by\s+([A-Z][\p{L}.'-]+(?:\s+[A-Z][\p{L}.'-]+){1,3})/u,
    /\bby\s+([A-Z][\p{L}.'-]+(?:\s+[A-Z][\p{L}.'-]+){1,3})/u,
  ];
  for (const re of patterns) {
    const name = text.match(re)?.[1]?.trim();
    if (name) return name;
  }
  return null;
}

function parsePerformance(event: Record<string, unknown>): RawPerformance | null {
  const m = asText(event.startDate).match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  if (!m?.[1]) return null;
  const date = m[1] as IsoDate;
  const today = new Date().toISOString().slice(0, 10);
  return {
    date,
    time: m[2] ?? null,
    venue_room: locationName(event) || VENUE,
    status: eventStatus(event.eventStatus, date, today),
  };
}

function parseCredits(event: Record<string, unknown>): {
  creative_team: RawCredit[];
  cast: RawCredit[];
} {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const castSeen = new Set<string>();
  const crewSeen = new Set<string>();

  for (const p of asArray<LdPerformer>(event.performer)) {
    const name = stripHtml(p.performer?.name ?? p.name ?? "");
    if (!name) continue;
    const role = stripHtml(p.characterName ?? "");
    const label = stripHtml(p.roleName ?? "");

    if (role || isRoleType(p["@type"])) {
      const character = role || label;
      if (!character) continue;
      const key = `${character}|${name}`;
      if (castSeen.has(key)) continue;
      castSeen.add(key);
      cast.push({ role: character, name });
      continue;
    }

    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    if (!fn) continue;
    const key = `${fn}|${name}`;
    if (crewSeen.has(key)) continue;
    crewSeen.add(key);
    creative_team.push({ function: fn, name });
  }
  return { creative_team, cast };
}

function isRoleType(t: string | string[] | undefined): boolean {
  const types = Array.isArray(t) ? t : t ? [t] : [];
  return types.some((x) => /PerformanceRole/i.test(x));
}

function eventStatus(status: unknown, date: IsoDate, today: string): RawPerformance["status"] {
  const s = asText(status);
  if (/EventCancelled/i.test(s)) return "cancelled";
  if (/SoldOut/i.test(s)) return "sold_out";
  return date < today ? "past" : "scheduled";
}

function locationName(event: Record<string, unknown>): string | null {
  const loc = event.location;
  if (!loc) return null;
  const first = Array.isArray(loc) ? loc[0] : loc;
  if (first && typeof first === "object") {
    return stripHtml(asText((first as { name?: unknown }).name)) || null;
  }
  return stripHtml(asText(first)) || null;
}

function languageCode(inLanguage: string): RawProduction["language"] {
  if (!inLanguage) return null;
  const code = inLanguage.trim().slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? (code as RawProduction["language"]) : null;
}

/** JSON-LD values are sometimes a bare string, sometimes an object with a name/url
 *  (e.g. `image: { url }`). Coerce to the most useful scalar. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return asText(value[0]);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return asText(o.url ?? o.name ?? o["@value"] ?? "");
  }
  return "";
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return value ? [value as T] : [];
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
