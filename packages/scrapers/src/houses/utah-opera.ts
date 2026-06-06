import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Utah Opera (`jsonld-event` strategy) — US opera company in Salt Lake City, Utah
 * (US/English), the opera half of the merged "Utah Symphony | Utah Opera" org. It
 * stages a ~4-title season (Oct–May) in the Janet Quinney Lawson Capitol Theatre.
 * The live scrape is the announced season; `backfill` appends Wikidata (currently
 * empty for this house — see below).
 *
 * WordPress (WP Rocket), one marketing site per arm under the shared usuo.org
 * brand. The joint `usuo.org/schedule/` mixes both arms by HOST — opera events
 * link to `utahopera.org/event/id/{id}/`, symphony events to `utahsymphony.org/…`
 * — so the opera-scoped `utahopera.org/schedule/` index already lists ONLY the
 * opera events (the symphony concerts, recitals, films-in-concert and galas live
 * on the sibling host and never appear here). That host scoping is the structural
 * Symphony|Opera filter; the composer gate below is the belt-and-braces opera test.
 *
 * Each `/event/id/{id}/` page splits across two structured sources:
 *   - schema.org `MusicEvent` JSON-LD, one node PER NIGHT: `startDate` (naive local
 *     "YYYY-MM-DDThh:mm", no zone), `location.name` (the venue), `name`, `image`,
 *     `description`. `performer.name` is the MusicGroup "Utah Opera" — a third
 *     confirmation of the arm, but it carries no composer/cast.
 *   - SSR HTML for the people: a `<strong>Composer…:</strong> {Name}` line in the
 *     description box (an ENGLISH structured field — NOT German composerFromText;
 *     present even when the composer is historical and has no bio card), plus
 *     `.artist` bio cards (`.artist-bio-detail-name` = name, `.artist-bio-detail-title`
 *     `<em>` = role). A card whose role maps to a creative function (CREATIVE_FUNCTIONS)
 *     is creative; a card whose role is a sung-role name is cast; the title-less
 *     ensemble cards (Utah Opera Chorus, Utah Symphony) are skipped.
 *
 * Opera filter: REQUIRE a composer. Past performances drop their JSON-LD once a
 * season closes, so the deep historical leg would come from Wikidata — but
 * Q17073493 has no P272/P4647 productions linked yet, so that backfill is empty.
 */

const BASE = "https://utahopera.org";

/** Utah Opera on Wikidata — the opera COMPANY (Q17073493, "US opera company"), NOT
 *  the sibling orchestra Utah Symphony (Q2778079). Verified via wbsearchentities on
 *  "Utah Opera": Q17073493 = "Utah Opera", description "US opera company". */
const WIKIDATA_QID = "Q17073493";

/** English bio-card role labels (`.artist-bio-detail-title`) → our canonical
 *  function slugs. Combined/assistant/associate/revival variants fold onto the
 *  principal function; an unmapped label (sound designer, etc.) is dropped rather
 *  than guessed — those cards are not cast either, since cast roles never match a
 *  function key. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "assistant conductor": "conductor",
  director: "director",
  "stage director": "director",
  "associate stage director": "director",
  "assistant stage director": "director",
  "revival director": "director",
  "associate director": "director",
  "assistant director": "director",
  "original production and staging": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "set and costume designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "projection designer": "projection-designer",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "movement director": "choreographer",
  "chorus master": "chorus-master",
  "chorus director": "chorus-master",
  "chorus director & assistant conductor": "chorus-master",
  dramaturg: "dramaturgy",
};

export async function scrapeUtahOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const id of await collectEventIds(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}/event/id/${id}/`, ctx), id, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`utah-opera: event ${id} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("utah-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("utah-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "utah-opera", productions };
}

/** The opera-scoped `/schedule/` lists every announced opera as `/event/id/{id}/`.
 *  Symphony events would link to the sibling host, so they never surface here. */
async function collectEventIds(ctx: FetchContext): Promise<string[]> {
  const ids = new Set<string>();
  for (const path of ["/schedule/", "/"]) {
    try {
      const html = await fetchHtml(`${BASE}${path}`, ctx);
      for (const [, id] of html.matchAll(/href="https:\/\/utahopera\.org\/event\/id\/(\d+)\/?"/g)) {
        if (id) ids.add(id);
      }
    } catch (err) {
      console.warn(`utah-opera: index ${path} failed:`, err);
    }
  }
  return [...ids];
}

function parseProduction(html: string, id: string, window: ScrapeWindow): RawProduction | null {
  const composer = parseComposer(html);
  // No composer ⇒ not a staged opera (the host scoping already keeps the symphony
  // arm out; this is the explicit opera gate).
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `utah-opera/${id}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(html),
    detail_url: `${BASE}/event/id/${id}/`,
    image_url: parseImage(html),
    synopsis: parseSynopsis(html),
    creative_team,
    cast,
    performances,
  };
}

/** `<strong>Composer[ and Librettist]:</strong> {Name}` in the description box.
 *  The colon may be followed by a stray `&nbsp;` inside or outside the `</strong>`,
 *  and the name may sit inside an `<a>` bio link; the value runs to the next tag.
 *  Present even for historical composers that carry no `.artist` bio card. */
function parseComposer(html: string): string | null {
  const m = html.match(
    /<strong>\s*Composer[^<]*?:\s*(?:&nbsp;)?\s*<\/strong>\s*(?:&nbsp;)?\s*(?:<a[^>]*>)?\s*([^<]+)/i,
  );
  const name = m ? stripHtml(decodeEntities(m[1] ?? "")) : "";
  return name && /[A-Za-z]/.test(name) ? name : null;
}

/** The `<title>` ("Mozart's Don Giovanni | Utah Opera"), brand suffix stripped.
 *  Preferred over og:title, which on these pages is the shared usuo placeholder
 *  "Explore"; h1 is the final fallback. */
function parseTitle(html: string): string | null {
  const title = stripHtml(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(
    /\s*[-–|]\s*Utah Opera\s*$/i,
    "",
  );
  if (title) return title;
  const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  return h1 || null;
}

/**
 * `.artist` bio cards: `.artist-bio-detail-name` is the person, the `<em>` inside
 * `.artist-bio-detail-title` is the role. A role that maps to a creative function
 * is creative; any other non-empty role is a sung character (cast); the title-less
 * ensemble cards (Utah Opera Chorus, Utah Symphony) carry no role and are skipped.
 * The composer/librettist bio card is dropped from cast — that credit is already
 * captured from the `<strong>Composer:</strong>` label, and it is not a sung role.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, rawName, rawTitle] of html.matchAll(
    /artist-bio-detail-name"><strong>([\s\S]*?)<\/strong>[\s\S]*?artist-bio-detail-title"><em>([\s\S]*?)<\/em>/g,
  )) {
    const name = stripHtml(decodeEntities(rawName ?? ""));
    const role = stripHtml(decodeEntities(rawTitle ?? ""));
    if (!name || !role) continue;
    if (/\b(composer|librettist)\b/i.test(role)) continue;

    const fn = CREATIVE_FUNCTIONS[role.toLowerCase()];
    if (fn) {
      const key = `c|${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    } else {
      const key = `r|${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role, name });
    }
  }
  return { creative_team, cast };
}

interface LdMusicEvent {
  "@type"?: string | string[];
  startDate?: string;
  location?: { name?: string };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the JSON-LD blobs embed raw control chars that break JSON.parse
const CONTROL_CHARS = /[\u0000-\u001f]/g;

/** The per-night `MusicEvent` JSON-LD blobs. These embed raw newlines/tabs in the
 *  `description` string (invalid JSON), which the shared `extractEventJsonLd` —
 *  strict `JSON.parse` — silently drops; we strip those control chars first so the
 *  blobs parse. Yoast's WebPage/@graph blob has no `@type === MusicEvent` and is
 *  ignored here. */
function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, " ");
}
function musicEventNodes(html: string): LdMusicEvent[] {
  const nodes: LdMusicEvent[] = [];
  for (const [, raw] of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripControlChars(raw ?? ""));
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as LdMusicEvent)["@type"] === "MusicEvent"
    ) {
      nodes.push(parsed as LdMusicEvent);
    }
  }
  return nodes;
}

/** Performances are the per-night `MusicEvent` JSON-LD nodes — `startDate` is naive
 *  local "YYYY-MM-DDThh:mm" (no zone), `location.name` the venue. Tickets are sold
 *  off-site, so status is past/scheduled by date. Honors window.since. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const node of musicEventNodes(html)) {
    const m = (node.startDate ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
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
      venue_room: stripHtml(node.location?.name ?? "") || null,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** "<strong>Language:</strong> Sung in English and Spanish with …" — the first
 *  named language wins; only single-language productions get a code (mixed-language
 *  titles like Zorro's "English and Spanish" stay null rather than misattribute). */
function languageCode(html: string): RawProduction["language"] {
  const m = html.match(/Sung in\s+([A-Za-z]+)(\s+and\s+[A-Za-z]+)?/i);
  if (!m || m[2]) return null;
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

function parseImage(html: string): string | null {
  return html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1] ?? null;
}

function parseSynopsis(html: string): string | null {
  const desc = html.match(/name=["']description["']\s+content=["']([^"']+)["']/i)?.[1];
  const text = desc ? stripHtml(decodeEntities(desc)) : "";
  return text || null;
}
