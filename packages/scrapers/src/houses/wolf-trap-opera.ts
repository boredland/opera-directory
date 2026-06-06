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
 * Wolf Trap Opera (`jsonld-event` strategy) — the young-artist SUMMER opera
 * program of the Wolf Trap Foundation in Vienna, Virginia (US/English). A
 * FESTIVAL: a handful of fully-staged operas each summer (June–August) at The
 * Barns / the Filene Center, dark the rest of the year, so the live scrape is the
 * current (already-announced) edition and `backfill` appends Wikidata for the
 * deep past.
 *
 * Wolf Trap is a big multi-genre venue (pop/jazz/orchestra at the Filene Center),
 * so this adapter scopes to the Wolf Trap Opera series only and isolates the
 * staged operas from the program's recitals/concerts. The `/opera/` landing page
 * is the season index; it links every WTO event as `/show/{NN}opera/{MMDDYY}/`
 * (the `opera` series prefix — the co-listed `{NN}filene/…` Filene-Center
 * concerts are out of scope by construction). Each show page carries:
 *   - schema.org `Event` JSON-LD, one node per performance night (`startDate`
 *     local ISO, `location.name` = "The Barns"), parsed for dates/times/venue.
 *   - An SSR "CAST" block (`<strong>Role:</strong> Name<br>`) and a "CREATIVE
 *     TEAM" block (`<strong>Function:</strong> Name<br>`). English function
 *     labels are mapped INSIDE this adapter (see CREATIVE_FUNCTIONS).
 *   - No structured composer field; the composer rides in the marketing
 *     description as `<Composer>'s "<Title>"` (e.g. Rossini's "La Cenerentola"),
 *     which `parseComposer` extracts.
 *
 * Opera filter: REQUIRE a composer AND a sung CAST. The season's recitals and
 * showcases (Aria Jukebox, Studio Artists in Concert, Salon Series, the Navy
 * Band / NSO concerts) publish neither a CAST/CREATIVE-TEAM block nor a
 * possessive-composer description, so they fail this test and drop out.
 */

const BASE = "https://www.wolftrap.org";
/** Wolf Trap Opera on Wikidata — the opera-producing residency PROGRAM
 *  (Q8029913, "Wolf Trap Opera Company", description "residency program for
 *  aspiring opera professionals"), NOT the Wolf Trap Foundation parent
 *  (Q54851829), the national park (Q3569664), or the Vienna VA census place
 *  (Q1376367). Verified via wbsearchentities (search "Wolf Trap Opera"). */
const WIKIDATA_QID = "Q8029913";

/** English creative-team labels → our canonical function slugs. Wolf Trap prints
 *  only a short team list; assistant/associate/revival variants fold onto the
 *  principal function and unmapped labels are dropped rather than guessed. */
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

export async function scrapeWolfTrapOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const path of await collectShowPaths(ctx)) {
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}${path}`, ctx), path, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`wolf-trap-opera: show ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("wolf-trap-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("wolf-trap-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "wolf-trap-opera", productions };
}

/** The `/opera/` landing page indexes the season as `/show/{NN}opera/{MMDDYY}/`
 *  links (the WTO `opera` series; co-listed `{NN}filene/…` concerts are skipped). */
async function collectShowPaths(ctx: FetchContext): Promise<string[]> {
  const paths = new Set<string>();
  const html = await fetchHtml(`${BASE}/opera/`, ctx);
  for (const [, p] of html.matchAll(
    /href="((?:https:\/\/www\.wolftrap\.org)?\/show\/\d+opera\/\d+\/)"/g,
  )) {
    if (p) paths.add(p.replace(BASE, ""));
  }
  return [...paths];
}

function parseProduction(html: string, path: string, window: ScrapeWindow): RawProduction | null {
  const { creative_team, cast } = parseCredits(html);
  // A staged opera bills both a sung CAST and a CREATIVE TEAM; the season's
  // recitals/concerts publish neither. First half of the opera filter.
  if (cast.length === 0) return null;

  const description = jsonValue(html, "description") ?? "";
  const composer = parseComposer(description);
  // The composer rides in the description as `<Composer>'s "<Title>"`; its
  // absence means a non-opera item slipped the cast test. Second half of the gate.
  if (!composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html);
  if (!title) return null;

  return {
    source_production_id: `wolf-trap-opera${path.replace(/\/$/, "")}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(html),
    detail_url: `${BASE}${path}`,
    image_url: jsonValue(html, "image"),
    synopsis: description || null,
    creative_team,
    cast,
    performances,
  };
}

/** The page title is the work title (the H1, or the JSON-LD Event `name`). */
function parseTitle(html: string): string | null {
  const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (h1) return h1;
  const name = jsonValue(html, "name");
  return name || null;
}

/** Read the composer from the marketing description's possessive byline, e.g.
 *  `Rossini's sparkling "La Cenerentola"` / `Tchaikovsky's "Eugene Onegin"`. The
 *  composer is the LAST `<Name>'s` possessive before the quoted work title — the
 *  earlier `Wolf Trap Opera's …` boilerplate is skipped by taking the last one. */
function parseComposer(description: string): string | null {
  const quote = description.search(/["“]/);
  const head = quote >= 0 ? description.slice(0, quote) : description;
  const matches = [...head.matchAll(/([A-Z][\p{L}.'-]+)['’]s\b/gu)];
  const name = matches.at(-1)?.[1]?.trim();
  return name && /\p{L}/u.test(name) ? name : null;
}

/**
 * Cast + creative team are two SSR `<p>` blocks, each a `<strong>SECTION</strong>`
 * header followed by `<strong>Label:</strong> Name<br>` pairs. A CAST block's
 * labels are sung roles; a CREATIVE TEAM block's labels are function names. The
 * "Chorus" cast line is the ensemble (no individual), so it is dropped.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  const castBlock = sectionBlock(html, "CAST");
  for (const [, role, name] of pairs(castBlock)) {
    if (/^chorus$/i.test(role)) continue;
    const key = `r|${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cast.push({ role, name });
  }

  const teamBlock = sectionBlock(html, "CREATIVE TEAM");
  for (const [, label, name] of pairs(teamBlock)) {
    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    if (!fn) continue;
    const key = `c|${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creative_team.push({ function: fn, name });
  }

  return { creative_team, cast };
}

/** Isolate the `<p>…</p>` block whose first `<strong>` is the given header. */
function sectionBlock(html: string, header: string): string {
  const re = new RegExp(`<p>\\s*<strong>\\s*${header}\\s*</strong>([\\s\\S]*?)</p>`, "i");
  return re.exec(html)?.[1] ?? "";
}

/** Yield `<strong>Label:</strong> Name` pairs (Name runs to the next <br>/tag). */
function pairs(block: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  // Labels occasionally carry a stray inner <br> (a source markup slip:
  // `<strong><br>Olga:</strong>`), so the label capture allows tags and is
  // tag-stripped rather than anchored on `[^<]`.
  for (const [, label, name] of block.matchAll(
    /<strong>((?:(?!<\/strong>).)*?):\s*<\/strong>\s*([^<]+)/g,
  )) {
    const l = stripHtml(label ?? "");
    // Asterisks mark Studio (apprentice) artists; keep the bare name.
    const n = stripHtml((name ?? "").replace(/\*+/g, ""));
    if (l && n) out.push(["", l, n]);
  }
  return out;
}

/** Performance nights are schema.org `Event` JSON-LD nodes: one per night with a
 *  local-time `startDate` and the venue in `location.name`. Honors window.since. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const node of eventNodes(html)) {
    const m = (typeof node.startDate === "string" ? node.startDate : "").match(
      /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/,
    );
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
      venue_room: venueName(node) ?? null,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

interface LdEvent {
  "@type"?: string;
  name?: string;
  startDate?: string;
  location?: { name?: string };
}

/** Pull `Event` nodes from the page's single `@graph` JSON-LD blob. */
function eventNodes(html: string): LdEvent[] {
  const raw = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  const graph =
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { "@graph"?: unknown })["@graph"])
      ? ((parsed as { "@graph": unknown[] })["@graph"] as LdEvent[])
      : Array.isArray(parsed)
        ? (parsed as LdEvent[])
        : [parsed as LdEvent];
  return graph.filter((n) => !!n && typeof n === "object" && n["@type"] === "Event");
}

function venueName(node: LdEvent): string | null {
  const name = stripHtml(node.location?.name ?? "");
  return name || null;
}

/** Read a top-level string JSON value (`"image"`, `"name"`, `"description"`) out
 *  of the page's JSON-LD, decoding the `\uXXXX`/`\"` JSON escapes it carries. */
function jsonValue(html: string, key: string): string | null {
  const raw = html.match(new RegExp(`"${key}":\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
  if (raw == null) return null;
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return decodeEntities(raw);
  }
}

/** The page prints "Sung in Italian with English captions." */
function languageCode(html: string): RawProduction["language"] {
  const first = html.match(/Sung in\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
  if (!first) return null;
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
