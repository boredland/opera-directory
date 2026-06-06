import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Lyric Opera of Chicago (`spielplan-html` strategy) — a Tier-1 US opera company
 * in Chicago, IL, performing a year-round multi-production season (~Sep–Jun) at
 * the Lyric Opera House (Civic Opera Building). Tessitura ticketing house, but the
 * production metadata (composer, cast, creative, dates) lives on the marketing
 * site's season pages — Tessitura only serves dates/availability — so we scrape
 * the marketing site. `backfill` appends Wikidata for the deep past.
 *
 * Cloudflare-gated (lyricopera.org returns a JS managed challenge to plain fetches
 * AND to the proxy's stealth render); only the proxy's FlareSolverr path (`&solve=1`)
 * clears it, so every fetch routes through `fetchSolved` (set `proxy: true` in
 * houses.json — without a configured proxy the adapter cannot reach the site).
 *
 * No JSON-LD or clean JSON API on the marketing pages. The season index
 * `/shows/upcoming/{season}-season/` links each production at
 * `/shows/upcoming/{season}/{slug}/`. Each detail page carries everything we need:
 *   - The composer in a properties list item `<strong>Composer:</strong> {Name}`
 *     (a structured field — NOT a German byline). Absent on concerts/film events.
 *   - Cast + creative team as artist cards: `<p class="artist-item-designation">`
 *     holds either a sung role (cast) or a known function label (creative team).
 *     English function labels are mapped INSIDE this adapter (see CREATIVE_FUNCTIONS);
 *     any designation not in that map is treated as a sung role.
 *   - Performance nights as `<p class="upcoming-date">` blocks: weekday, MM/DD/YYYY,
 *     and a local clock time ("7:30 PM").
 *   - Language ("Sung in Italian …") and venue ("Location:") in the properties list.
 *
 * Opera filter: a staged opera has a `Composer:` property AND sung cast. The season
 * grid also lists film-with-orchestra ("Encanto in Concert"), in-concert galas,
 * oratorios, musicals and auditions — those carry no composer property and/or no
 * sung roles, so they fail the filter and are dropped.
 */

const BASE = "https://www.lyricopera.org";
/** Lyric Opera of Chicago on Wikidata — the opera COMPANY, not the Civic Opera
 *  House building. Verified via wbsearchentities: Q653885 = "Lyric Opera of
 *  Chicago", description "non-profit organization in the USA". */
const WIKIDATA_QID = "Q653885";

/** English creative-team designations → our canonical function slugs. Any artist
 *  card whose designation is NOT in this map is treated as sung cast (its
 *  designation is the role). "Composer" is deliberately absent — on this site it
 *  appears only as a sung CHARACTER (e.g. Ariadne auf Naxos), never a credit. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "original director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "set & costume designer": "set-designer",
  "set and costume designer": "set-designer",
  "set & projection designer": "set-designer",
  "set and projection designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  "projection & video designer": "video-designer",
  "projection and video designer": "video-designer",
  choreographer: "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeLyricOperaOfChicago(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const path of await collectProductionPaths(ctx)) {
      try {
        const prod = parseProduction(await fetchSolved(`${BASE}${path}`, ctx), path, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`lyric-opera-of-chicago: production ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("lyric-opera-of-chicago: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("lyric-opera-of-chicago: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "lyric-opera-of-chicago", productions };
}

/** Find the current + next season index (`/shows/upcoming/{season}-season/`) and
 *  collect the `/shows/upcoming/{season}/{slug}/` production links from each. The
 *  upcoming hub itself only surfaces a couple, so we go through the season pages. */
async function collectProductionPaths(ctx: FetchContext): Promise<string[]> {
  const paths = new Set<string>();
  for (const season of seasonSlugs()) {
    try {
      const html = await fetchSolved(`${BASE}/shows/upcoming/${season}-season/`, ctx);
      for (const [, path] of html.matchAll(/href="(\/shows\/upcoming\/[^"]+\/)"/g)) {
        if (path && isProductionPath(path)) paths.add(path);
      }
    } catch {
      // A future season's index may not exist yet — non-fatal.
    }
  }
  return [...paths];
}

/** A production link is `/shows/upcoming/{season}/{slug}/` — two segments past
 *  `/shows/upcoming/`. The season-index pages (`{season}-season/`) and the hub
 *  itself have one segment; ancillary auditions slip past the path shape but fail
 *  the opera filter downstream. */
function isProductionPath(path: string): boolean {
  const rest = path.replace(/^\/shows\/upcoming\//, "").replace(/\/$/, "");
  const segments = rest.split("/");
  return segments.length === 2 && !segments[0]?.endsWith("-season");
}

/** US seasons start in autumn: a slug is "{Y}-{(Y+1)%100}", e.g. "2026-27". Before
 *  September we're still in the {Y-1}/{Y} season, so cover this season and next. */
function seasonSlugs(): string[] {
  const now = new Date();
  const start = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const slug = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
  return [slug(start), slug(start + 1)];
}

function parseProduction(html: string, path: string, window: ScrapeWindow): RawProduction | null {
  const composer = propertyValue(html, "Composer");
  // No composer property ⇒ a film-with-orchestra / in-concert gala / audition, not
  // staged opera.
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(html);
  // A staged opera bills sung roles; song programmes carry none.
  if (cast.length === 0) return null;

  const title = parseTitle(html, path);
  if (!title) return null;

  // Drop in-concert presentations (e.g. "Hérodiade: An Opera in Concert") and
  // oratorios billed by voice type ("Soprano"/"Tenor"/"Bass") rather than named
  // characters — both carry a composer + singers but are not staged opera.
  if (/\bin concert\b/i.test(title) || /-in-concert\b/.test(path)) return null;
  if (cast.every((c) => isVoiceType(c.role))) return null;

  const performances = parsePerformances(html, window, propertyValue(html, "Location"));
  if (performances.length === 0) return null;

  return {
    source_production_id: `lyric-opera-of-chicago/${path.replace(/^\/shows\/upcoming\//, "").replace(/\/$/, "")}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(propertyValue(html, "Language")),
    detail_url: `${BASE}${path}`,
    creative_team,
    cast,
    performances,
  };
}

/** The `<h1>` carries an optional `adage-detail-page-pretitle` <span> (a tagline)
 *  before the work title — strip it. Falls back to the slug. */
function parseTitle(html: string, path: string): string | null {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "";
  const withoutPretitle = h1.replace(
    /<span class="adage-detail-page-pretitle">[\s\S]*?<\/span>/,
    "",
  );
  return stripHtml(withoutPretitle) || slugToTitle(path);
}

/** Read a properties-list value by its bold label ("Composer", "Language",
 *  "Location"): `<li …><strong>{Label}:</strong> {value}</li>`. */
function propertyValue(html: string, label: string): string | null {
  for (const [, key, value] of html.matchAll(
    /<li class="adage-detail-page-properties-item">\s*<strong>([^<]*?):<\/strong>([\s\S]*?)<\/li>/g,
  )) {
    if (stripHtml(key ?? "").toLowerCase() === label.toLowerCase()) {
      const v = stripHtml(value ?? "");
      return v || null;
    }
  }
  return null;
}

/**
 * Each artist card is `<h3 class="artist-item-name">Name</h3>` followed by
 * `<p class="artist-item-designation">{Role or Function}</p>`. A designation in
 * CREATIVE_FUNCTIONS is a production-team credit; anything else is a sung role.
 * Names trail a debut marker ("*"/"**"); roles trail an alternating-cast date
 * qualifier ("Don Giovanni (10/30, 11/1)") — both stripped.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, nameRaw, desigRaw] of html.matchAll(
    /class="artist-item-name[^"]*"[^>]*>([\s\S]*?)<\/h3>\s*<p class="artist-item-designation">([\s\S]*?)<\/p>/g,
  )) {
    const name = cleanName(stripHtml(nameRaw ?? ""));
    const designation = stripHtml(desigRaw ?? "");
    if (!name || !designation) continue;

    const fn = CREATIVE_FUNCTIONS[designation.toLowerCase()];
    if (fn) {
      const key = `c|${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    } else {
      const role = cleanRole(designation);
      const key = `r|${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role, name });
    }
  }
  return { creative_team, cast };
}

/** Performance nights are `<p class="upcoming-date">` blocks: a weekday, an
 *  MM/DD/YYYY date, and a "h:mm AM/PM" clock time, separated by <br>. */
function parsePerformances(
  html: string,
  window: ScrapeWindow,
  venue: string | null,
): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, block] of html.matchAll(/<p class="upcoming-date">([\s\S]*?)<\/p>/g)) {
    const text = stripHtml(block ?? "");
    const dm = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!dm) continue;
    const date =
      `${dm[3]}-${(dm[1] ?? "").padStart(2, "0")}-${(dm[2] ?? "").padStart(2, "0")}` as IsoDate;
    if (window.since && date < window.since) continue;
    const time = parseClock(text);

    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** "7:30 PM" → "19:30"; "2:00 PM" → "14:00". Null when no clock time is printed. */
function parseClock(text: string): string | null {
  const m = text.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  let hour = Number.parseInt(m[1] ?? "0", 10) % 12;
  if (/pm/i.test(m[3] ?? "")) hour += 12;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

/** Drop the trailing debut marker ("Name *" / "Name **"). */
function cleanName(name: string): string {
  return name.replace(/\s*\*+\s*$/, "").trim();
}

/** Drop an alternating-cast date qualifier ("Don Giovanni (10/30, 11/1)"). */
function cleanRole(role: string): string {
  return role.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** A generic voice-part label rather than a named character — how oratorios
 *  (Haydn's *The Creation*) bill their soloists. */
function isVoiceType(role: string | null | undefined): boolean {
  return (
    !!role &&
    /^(soprano|mezzo[- ]?soprano|alto|contralto|tenor|baritone|bass[- ]?baritone|bass)$/i.test(
      role.trim(),
    )
  );
}

/** "Sung in Italian with projected English titles" → ISO 639-1; null otherwise. */
function languageCode(sungIn: string | null): RawProduction["language"] {
  if (!sungIn) return null;
  const m = sungIn.match(/\b(italian|english|german|french|russian|czech|spanish)\b/i);
  if (!m) return null;
  return (
    ({
      italian: "it",
      english: "en",
      german: "de",
      french: "fr",
      russian: "ru",
      czech: "cs",
      spanish: "es",
    }[(m[1] ?? "").toLowerCase()] as RawProduction["language"]) ?? null
  );
}

function slugToTitle(path: string): string {
  return (path.replace(/\/$/, "").split("/").pop() ?? "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * lyricopera.org is behind a Cloudflare managed challenge: a plain fetch and the
 * proxy's stealth render both get the challenge page; only the proxy's
 * FlareSolverr path (`&solve=1`) clears it. So we hand-build the proxy request
 * here rather than using fetchHtml/fetchRendered. Without a configured proxy this
 * falls back to a direct fetch (which will fail the challenge — the house needs
 * the proxy).
 */
async function fetchSolved(url: string, ctx: FetchContext): Promise<string> {
  const target = ctx.proxy ? `${ctx.proxy.url}?url=${encodeURIComponent(url)}&solve=1` : url;
  const headers: Record<string, string> = { "User-Agent": ctx.userAgent };
  if (ctx.proxy?.token) headers.Authorization = `Bearer ${ctx.proxy.token}`;
  const res = await fetch(target, { headers, signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`fetch failed: ${url} → ${res.status}`);
  return res.text();
}
