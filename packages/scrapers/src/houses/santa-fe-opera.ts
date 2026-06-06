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
 * Santa Fe Opera (`jsonld-event` strategy) — the open-air summer opera festival
 * in Santa Fe, New Mexico (US/English). A FESTIVAL: one season at a time, late
 * June–August, dark the rest of the year, so the live scrape is the current (and
 * already-announced next) season; `backfill` appends Wikidata for the deep past.
 *
 * WordPress site. The season's productions are `/whats-on/{slug}-{year}/` pages,
 * linked from the homepage and the tickets index; the same slug list covers both
 * the running season and the next, already-announced one. Each detail page is one
 * production and carries everything we need:
 *   - Performance dates + start times as schema.org `Event` JSON-LD (one Event per
 *     night, `startDate` "YYYY-MM-DDThh:mm:ss-06:00", `eventStatus`). `extractEventJsonLd`
 *     would also catch the per-night AggregateOffer-less nodes, but we parse the
 *     blob directly to read `eventStatus` per night.
 *   - The composer in a `c-event-meta__row` labelled "Music By" (ENGLISH byline /
 *     structured field — NOT the German composerFromText), plus "Sung in" language.
 *   - Cast + creative team as `c-col-bio` cards: a singer card carries a
 *     `c-col-bio__role` (the sung role); a production-team card has only the
 *     `c-col-bio__voice-type`, which there holds the function label.
 * The opera filter is: a real staging has a composer ("Music By") AND sung cast —
 * the season's "Apprentice Scenes & Concert" and travel-package pages have neither.
 * English function labels are mapped INSIDE this adapter (see CREATIVE_FUNCTIONS).
 * Every performance is in the Crosby Theatre (the only stage), so venue is fixed.
 */

const BASE = "https://www.santafeopera.org";
/** Santa Fe Opera on Wikidata — the opera COMPANY (Q7204962), not the former
 *  theatres (Q66907759 / Q66908007) or the current Crosby Theatre (Q66908646).
 *  Verified via wbsearchentities: Q7204962 = "Santa Fe Opera", description
 *  "opera company in Santa Fe, New Mexico". */
const WIKIDATA_QID = "Q7204962";
const VENUE = "Crosby Theatre";

/** English creative-team labels → our canonical function slugs. Any bio card whose
 *  label is NOT in this map and that carries a sung role is cast; an unmapped
 *  team-card label (e.g. "Production", "Illusions") is dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  director: "director",
  "stage director": "director",
  "associate director": "director",
  "assistant director": "director",
  "scenic designer": "set-designer",
  "set designer": "set-designer",
  "associate scenic designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection & video designer": "projection-designer",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus director": "chorus-master",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeSantaFeOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const slugs = await collectEventSlugs(ctx);
    for (const slug of slugs) {
      try {
        const html = await fetchHtml(`${BASE}/whats-on/${slug}/`, ctx);
        const prod = parseProduction(html, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`santa-fe-opera: event ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("santa-fe-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("santa-fe-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "santa-fe-opera", productions };
}

/** Walk the homepage + tickets index, collecting unique `/whats-on/{slug}/` slugs.
 *  Both list the running season and the next, already-announced one. */
async function collectEventSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  for (const path of ["/", "/tickets/"]) {
    try {
      const html = await fetchHtml(`${BASE}${path}`, ctx);
      for (const [, slug] of html.matchAll(
        /href="https:\/\/www\.santafeopera\.org\/whats-on\/([^"/]+)\/"/g,
      )) {
        if (slug) slugs.add(slug);
      }
    } catch (err) {
      console.warn(`santa-fe-opera: index ${path} failed:`, err);
    }
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const composer = metaValue(html, "Music By");
  // No composer ⇒ a concert / apprentice showcase / travel package, not staged opera.
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(html);
  // A staged opera bills sung roles; the non-opera season items that slip past the
  // composer test carry none. This is the opera filter.
  if (cast.length === 0) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title =
    stripHtml(html.match(/c-masthead__title">([\s\S]*?)<\/h1>/)?.[1] ?? "") || slugToTitle(slug);
  if (!title) return null;

  return {
    source_production_id: `santa-fe-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(metaValue(html, "Sung in")),
    detail_url: `${BASE}/whats-on/${slug}/`,
    creative_team,
    cast,
    performances,
  };
}

/** Read a `c-event-meta__row` value by its label ("Music By", "Sung in"). */
function metaValue(html: string, label: string): string | null {
  for (const m of html.matchAll(
    /c-event-meta__label">([\s\S]*?)<\/div>\s*<div class="c-event-meta__value">([\s\S]*?)<\/div>/g,
  )) {
    if (stripHtml(m[1] ?? "").toLowerCase() === label.toLowerCase()) {
      const value = stripHtml(m[2] ?? "");
      return value || null;
    }
  }
  return null;
}

/**
 * Each artist is a `c-col-bio` card: `<h4 class="c-col-bio__name">Name</h4>` then a
 * `c-col-bio__voice-type` and, for singers only, a `c-col-bio__role`. A card WITH a
 * role is sung cast (voice-type is the Fach); a card with no role is a production-team
 * credit whose voice-type IS the function label.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(
    /c-col-bio__name">([\s\S]*?)<\/h4>\s*<p class="c-col-bio__voice-type">([\s\S]*?)<\/p>(?:\s*<p class="c-col-bio__role">([\s\S]*?)<\/p>)?/g,
  )) {
    const name = stripHtml(m[1] ?? "");
    if (!name) continue;
    const voiceOrFunction = stripHtml(m[2] ?? "");
    const role = m[3] != null ? cleanRole(stripHtml(m[3])) : null;

    if (role) {
      const key = `cast|${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role, name });
    } else {
      const fn = CREATIVE_FUNCTIONS[voiceOrFunction.toLowerCase()];
      if (!fn) continue;
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    }
  }
  return { creative_team, cast };
}

/** Performance nights are schema.org `Event` JSON-LD: one per night, with the
 *  local-time `startDate` and `eventStatus`. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const node of eventNodes(html)) {
    const start = typeof node.startDate === "string" ? node.startDate : "";
    const m = start.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
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
      status: eventStatus(node.eventStatus, date, today),
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Pull the page's single JSON-LD array and return its `Event` nodes. */
function eventNodes(html: string): Record<string, unknown>[] {
  const raw = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.filter(
    (n): n is Record<string, unknown> =>
      !!n && typeof n === "object" && (n as Record<string, unknown>)["@type"] === "Event",
  );
}

function eventStatus(status: unknown, date: IsoDate, today: string): RawPerformance["status"] {
  if (typeof status === "string" && /EventCancelled/i.test(status)) return "cancelled";
  return date < today ? "past" : "scheduled";
}

/** "Italian" / "English" → ISO 639-1; null when the house doesn't list a language. */
function languageCode(sungIn: string | null): RawProduction["language"] {
  if (!sungIn) return null;
  const first =
    sungIn
      .split(/[,/]|\band\b/)[0]
      ?.trim()
      .toLowerCase() ?? "";
  return (
    ({
      italian: "it",
      english: "en",
      german: "de",
      french: "fr",
      russian: "ru",
      czech: "cs",
      spanish: "es",
    }[first] as RawProduction["language"]) ?? null
  );
}

/** A role can trail a date qualifier ("B.F. Pinkerton (Jul 3 - Aug 20)") for an
 *  alternating cast; keep the role, drop the night range. */
function cleanRole(role: string): string {
  return role.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/-\d{4}$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
