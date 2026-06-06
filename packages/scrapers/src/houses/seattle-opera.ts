import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, proxyFetch, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Seattle Opera (`spielplan-html` strategy) — the Tier-1 US opera company in
 * Seattle, WA (US/English), staging its season Aug–May at McCaw Hall.
 *
 * Seattle is a Tessitura ticketing house: `www.seattleopera.org` is a thin SPA
 * shell that, on first paint, fetches an encrypted TNEW session key from
 * `secure.seattleopera.org/api/session/sessionkey` (the call needs a JSON
 * Content-Type, else 400), drops it as a `TNEWEncryptedSession` cookie, and
 * reloads — only THEN does the ASP.NET marketing site serve real HTML. We
 * replicate that exactly in `sessionCookie()`: one keyed fetch up front, then
 * every page request carries the cookie. (The Tessitura production/performance
 * JSON API itself sits behind further session state — 302s — so production
 * metadata is read from the marketing pages, not the cart API.)
 *
 * Production metadata lives on `/performances-events/{slug}/` detail pages:
 *   - Performance dates + venue: the masthead `play-detail-hero-final-info-dates`
 *     block holds one `<p>` of "Month d, d, …, & d, YYYY<br/>Venue" — the whole
 *     run as a comma list. McCaw Hall is the only stage.
 *   - Composer: the centered "Music by {Composer}" credit byline (ENGLISH byline,
 *     NOT German composerFromText).
 *   - Cast + creative team: `cast-member-bio` cards pairing an `artistNameBio`
 *     name with a `cast-member-bio-detail-character` label — a sung role for cast,
 *     a function name (Conductor, Stage Director, …) for the team. English labels
 *     are mapped INSIDE this adapter (see CREATIVE_FUNCTIONS).
 *
 * Discovery: the `/performances-events/` index lists the running + announced
 * seasons' slugs (the live leg, both modes); `/performances-events/archive/`
 * lists every past slug (backfill only). Both indexes mix in talks, recitals,
 * galas and community days — the opera filter is "has a composer AND sung cast",
 * which every staging passes and every non-opera page fails. `backfill` also
 * appends Wikidata for the deep past.
 */

const BASE = "https://www.seattleopera.org";
const SESSION_KEY_URL = "https://secure.seattleopera.org/api/session/sessionkey";
/** Seattle Opera on Wikidata — the opera COMPANY (Q7442146), not McCaw Hall
 *  (Q11705574) or the former Opera House (Q78636600). Verified via
 *  wbsearchentities: Q7442146 = "Seattle Opera", description "opera company in
 *  Seattle, Washington, U.S." */
const WIKIDATA_QID = "Q7442146";

/** English creative-team labels (the `cast-member-bio-detail-character` of a
 *  no-role team card) → our canonical function slugs. A bio card whose label is
 *  NOT here and that carries a sung role is cast; an unmapped team label (stage
 *  manager, fight director, assistant director, …) is dropped, not guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  director: "director",
  "stage director": "director",
  "revival stage director": "director",
  "stage director & choreographer": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "set & costume designer": "set-designer",
  "scenery & costume designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "projection & video designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "original choreographer": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeSeattleOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const cookie = await sessionCookie(ctx);
    const index = window.mode === "backfill" ? "archive/" : "";
    const slugs = await collectSlugs(`${BASE}/performances-events/${index}`, ctx, cookie);
    for (const slug of slugs) {
      try {
        const html = await fetchPage(`${BASE}/performances-events/${slug}/`, ctx, cookie);
        const prod = parseProduction(html, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`seattle-opera: event ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("seattle-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("seattle-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "seattle-opera", productions };
}

/** The marketing site serves real HTML only to a client carrying a TNEW session
 *  cookie; without it every path returns the 2 KB SPA spinner shell. Mint one
 *  encrypted session key (the endpoint needs a JSON Content-Type) and return it
 *  as the Cookie header value reused for every page fetch. */
async function sessionCookie(ctx: FetchContext): Promise<string | null> {
  const res = await proxyFetch(SESSION_KEY_URL, ctx.proxy, {
    headers: {
      "User-Agent": ctx.userAgent,
      "Content-Type": "application/json",
      Referer: `${BASE}/`,
    },
  });
  if (!res.ok) {
    console.warn(`seattle-opera: session key → ${res.status}`);
    return null;
  }
  const key = ((await res.json()) as { encryptedSessionKey?: string })?.encryptedSessionKey;
  return typeof key === "string" && key ? `TNEWEncryptedSession=${key}` : null;
}

/** Fetch a marketing page carrying the TNEW session cookie (without it the host
 *  serves only the SPA spinner shell). Falls back to a plain fetch if no cookie
 *  was minted. */
async function fetchPage(url: string, ctx: FetchContext, cookie: string | null): Promise<string> {
  if (!cookie) return fetchHtml(url, ctx);
  const res = await proxyFetch(url, ctx.proxy, {
    headers: { "User-Agent": ctx.userAgent, Cookie: cookie },
  });
  if (!res.ok) throw new Error(`fetch failed: ${url} → ${res.status}`);
  return res.text();
}

/** Collect the `/performances-events/{slug}/` slugs from an index page, dropping
 *  the non-production sub-sections (bios, the archive index itself). */
async function collectSlugs(
  url: string,
  ctx: FetchContext,
  cookie: string | null,
): Promise<string[]> {
  const html = await fetchPage(url, ctx, cookie);
  const slugs = new Set<string>();
  for (const [, slug] of html.matchAll(/\/performances-events\/([^/"&]+)\//g)) {
    if (slug && slug !== "bios" && slug !== "archive") slugs.add(slug);
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const composer = composerFromByline(html);
  // No composer ⇒ a talk / recital / gala / community day, not staged opera.
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(html);
  // A staging bills named character roles (Salome, Mimì); a recital/concert bills
  // its singers by voice type ("Tenor", "Soprano") or instrument ("Pianist"). The
  // opera filter: require at least one named-character role, not a bare voice type.
  if (!cast.some((c) => c.role && !VOICE_TYPE.has(c.role.toLowerCase()))) return null;

  const { performances, venue } = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "") || slugToTitle(slug);
  if (!title) return null;

  return {
    source_production_id: `seattle-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    premiere_date: performances[0]?.date ?? null,
    detail_url: `${BASE}/performances-events/${slug}/`,
    creative_team,
    cast,
    performances: venue ? performances.map((p) => ({ ...p, venue_room: venue })) : performances,
  };
}

/** The composer is the bolded credit byline "<strong>Music by {Composer}<br/>
 *  Libretto by …</strong>". Anchoring on the bold + the trailing `<br>` avoids
 *  matching prose like "…newer music by Nina Simone…" in a recital blurb. */
function composerFromByline(html: string): string | null {
  const m = html.match(/<strong>\s*Music by\s+([^<]+?)\s*<br/i);
  const composer = m ? decodeEntities(m[1] ?? "").trim() : "";
  return composer && /[A-Za-z]/.test(composer) ? composer : null;
}

/**
 * Each artist is a `cast-member-bio` card: an `artistNameBio` span (the name)
 * followed by a `cast-member-bio-detail-character` label. The page splits the
 * cards into a sung-Cast section and a "Creative Team" section with an `<h2>`
 * heading between them — so cards BEFORE that boundary are cast (the label is a
 * character), cards AFTER are team (the label is a function). We split on the
 * boundary rather than guessing per-label, then map known team functions and
 * DROP unmapped ones (stage managers, fight directors, assistants). Alternating
 * casts repeat a role, so dedupe.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const boundary = html.search(/<h2[^>]*>\s*Creative Team\s*<\/h2>/i);
  const castHtml = boundary >= 0 ? html.slice(0, boundary) : html;
  const teamHtml = boundary >= 0 ? html.slice(boundary) : "";

  const cast: RawCredit[] = [];
  const seenCast = new Set<string>();
  for (const [, name, role] of bioCards(castHtml)) {
    const r = cleanRole(role);
    const key = `${r}|${name}`;
    if (!r || seenCast.has(key)) continue;
    seenCast.add(key);
    cast.push({ role: r, name });
  }

  const creative_team: RawCredit[] = [];
  const seenTeam = new Set<string>();
  for (const [, name, label] of bioCards(teamHtml)) {
    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    const key = `${fn}|${name}`;
    if (!fn || seenTeam.has(key)) continue;
    seenTeam.add(key);
    creative_team.push({ function: fn, name });
  }
  return { creative_team, cast };
}

/** Yield [_, name, label] for each `cast-member-bio` card in a slice of HTML. */
function bioCards(html: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const [, nameRaw, labelRaw] of html.matchAll(
    /artistNameBio">([^<]*)<\/span>\s*<\/p>\s*<p class="cast-member-bio-detail-character">([^<]*)<\/p>/g,
  )) {
    const name = stripHtml(nameRaw ?? "");
    const label = stripHtml(labelRaw ?? "");
    if (name && label) out.push(["", name, label]);
  }
  return out;
}

/** The masthead `play-detail-hero-final-info-dates` block holds one `<p>` of
 *  "Month d, d, …, & d, YYYY<br/>Venue" — the full run as a comma list with the
 *  year once at the end, then the venue. Expand it into one performance per day. */
function parsePerformances(
  html: string,
  window: ScrapeWindow,
): { performances: RawPerformance[]; venue: string | null } {
  const today = new Date().toISOString().slice(0, 10);
  const block = html.match(
    /play-detail-hero-final-info-dates"[\s\S]*?<div>\s*<p>([\s\S]*?)<\/p>/,
  )?.[1];
  if (!block) return { performances: [], venue: null };

  const [datePart, venuePart] = block.split(/<br\s*\/?>/i);
  const venue = venuePart ? stripHtml(venuePart) || null : null;

  const text = stripHtml(datePart ?? "");
  const year = text.match(/\b(20\d\d)\b/)?.[1];
  if (!year) return { performances: [], venue };

  const monthMatch = text.match(/([A-Z][a-z]+)\s/);
  const month = monthMatch ? MONTHS[monthMatch[1]?.toLowerCase() ?? ""] : undefined;
  if (!month) return { performances: [], venue };

  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const [, day] of text.matchAll(/\b(\d{1,2})\b/g)) {
    if (day === year.slice(2) || day === year) continue;
    const dd = (day ?? "").padStart(2, "0");
    const date = `${year}-${month}-${dd}` as IsoDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(dd) < 1 || Number(dd) > 31) continue;
    if (window.since && date < window.since) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, time: null, status: date < today ? "past" : "scheduled" });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return { performances: out, venue };
}

/** A role can carry a "(cover)" / standby qualifier; keep the role, drop it. */
function cleanRole(role: string): string {
  return role.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/-\d{4}$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Voice types / instruments a recital bills its performers under — never the
 *  named character a staged opera casts. Used by the opera filter. */
const VOICE_TYPE = new Set([
  "soprano",
  "mezzo-soprano",
  "mezzo",
  "contralto",
  "countertenor",
  "tenor",
  "baritone",
  "bass-baritone",
  "bass",
  "soloist",
  "vocalist",
  "singer",
  "pianist",
  "piano",
  "accompanist",
  "narrator",
  "host",
]);

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};
