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
 * Portland Opera (`json-api` strategy) — a year-round US opera company in
 * Portland, Oregon (US/English), staging its season at the Keller Auditorium and
 * the Newmark Theatre (some titles summer-weighted). The live scrape is the
 * announced season; `backfill` appends Wikidata for the deep past — only the
 * current/announced season is browsable on the site, so older productions come
 * from the aggregator.
 *
 * Umbraco CMS with a Vue calendar. The `/performances-tickets/` index links each
 * staged production at `/performances-tickets/{season}/{slug}/`. Each production
 * page is server-rendered and carries two things:
 *   - the composer + cast/creative as prose in the `description__author` block —
 *     "Composed by {Name}" is an ENGLISH structured line (NOT German
 *     composerFromText); credit lines ("{Function}: {Name}") are mapped to our
 *     slugs INSIDE this adapter via CREATIVE_FUNCTIONS.
 *   - a `<minicalendar :production-id="{N}">` hook whose id keys the Umbraco
 *     surface API `POST /umbraco/surface/events/getprodevents {prodId}` — a clean
 *     JSON feed of every performance night (`StartDate` epoch-ms wall-clock,
 *     `TimeStr`, `Venue.Name`, `Category`, ticket link). No runtime browser: read
 *     the SSR HTML + that one JSON endpoint.
 *
 * Opera filter: REQUIRE a composer AND that the production's events carry
 * `Category === "Operas"`. The "Community" items (Opera a la Cart pop-ups,
 * matchday partnerships) and other non-staged events fail one or both tests.
 */

const BASE = "https://www.portlandopera.org";
const PROD_EVENTS_API = `${BASE}/umbraco/surface/events/getprodevents`;

/** Portland Opera on Wikidata — the opera COMPANY. Verified via wbsearchentities:
 *  Q4373261 = "Portland Opera", description "opera company in Portland, Oregon,
 *  United States". */
const WIKIDATA_QID = "Q4373261";

/** English credit labels (the prose "{Function}: {Name}" lines) → our canonical
 *  function slugs. Assistant/associate/revival variants fold onto the principal
 *  function; an unmapped label is dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
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

interface ProdEvent {
  Category?: string;
  StartDate?: string;
  TimeStr?: string;
  TixUrl?: string;
  Venue?: { Name?: string };
}

export async function scrapePortlandOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const path of await collectProductionPaths(ctx)) {
      try {
        const prod = await parseProduction(path, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`portland-opera: production ${path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("portland-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("portland-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "portland-opera", productions };
}

/** The `/performances-tickets/` index links each staged production at
 *  `/performances-tickets/{season}/{slug}/`. The homepage carries the same set,
 *  so it's a cheap fallback when the index markup shifts. */
async function collectProductionPaths(ctx: FetchContext): Promise<string[]> {
  const paths = new Set<string>();
  for (const path of ["/performances-tickets/", "/"]) {
    try {
      const html = await fetchHtml(`${BASE}${path}`, ctx);
      for (const [, p] of html.matchAll(
        /href="(?:https:\/\/www\.portlandopera\.org)?(\/performances-tickets\/\d{2}-\d{2}-season\/[^"#]+\/)"/g,
      )) {
        if (p) paths.add(p);
      }
    } catch (err) {
      console.warn(`portland-opera: index ${path} failed:`, err);
    }
  }
  return [...paths];
}

async function parseProduction(
  path: string,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const html = await fetchHtml(`${BASE}${path}`, ctx);

  const composer = parseComposer(html);
  // No composer ⇒ not a staged opera (a teaser/package page). The opera gate.
  if (!composer) return null;

  const prodId = html.match(/:production-id="(\d+)"/)?.[1];
  if (!prodId) return null;

  const { performances, isOpera } = await fetchPerformances(prodId, ctx, window);
  // The events feed labels staged opera "Operas"; community pop-ups carry a
  // different Category and are excluded even if a page lists a composer.
  if (!isOpera) return null;
  if (performances.length === 0) return null;

  const title = parseTitle(html);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `portland-opera${path.replace(/\/$/, "")}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(html),
    detail_url: `${BASE}${path}`,
    creative_team,
    cast,
    performances,
  };
}

/** "Composed by Giuseppe Verdi" / "Composed by George Gershwin, arranged by …" —
 *  the value runs to the next tag, comma, or "arranged"/"orchestrated" clause. */
function parseComposer(html: string): string | null {
  const m = html.match(/Composed by\s+([^<,(]+?)(?:\s*,|\s+arranged\b|\s+orchestrated\b|<)/i);
  const composer = m ? stripHtml(m[1] ?? "").trim() : "";
  return composer && /[A-Za-z]/.test(composer) ? composer : null;
}

function parseTitle(html: string): string | null {
  const og = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1];
  if (og) {
    const title = decodeEntities(og)
      .replace(/\s*[-–|]\s*Portland Opera\s*$/i, "")
      .trim();
    if (title) return title;
  }
  const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  return h1 || null;
}

/**
 * Credits are prose `<p>` lines in the production description block, "{Label}:
 * {Name}" or "{Label} — {Name}". A label in CREATIVE_FUNCTIONS is a creative
 * credit; an unmapped label is dropped. Early-announcement pages list none yet —
 * an empty result is fine (the production still stands on composer + dates).
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [, raw] of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const line = stripHtml(raw ?? "");
    const m = line.match(/^([A-Za-z][A-Za-z &/]+?)\s*[:–—-]\s*(.+)$/);
    if (!m) continue;
    const fn = CREATIVE_FUNCTIONS[(m[1] ?? "").trim().toLowerCase()];
    const name = (m[2] ?? "").trim();
    if (!fn || !name || !/[A-Za-z]/.test(name)) continue;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creative_team.push({ function: fn, name });
  }

  // Per-night cast is not published in a structured field; left empty (the
  // resolver still anchors the production via composer + work title).
  return { creative_team, cast: [] };
}

/** Fetch the production's performance nights from the Umbraco surface API and
 *  report whether they are staged opera (`Category === "Operas"`). The POST body
 *  goes through the proxy when configured, so a blocked datacenter IP still
 *  reaches the JSON endpoint. */
async function fetchPerformances(
  prodId: string,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<{ performances: RawPerformance[]; isOpera: boolean }> {
  let events: ProdEvent[];
  try {
    const res = await proxyFetch(PROD_EVENTS_API, ctx.proxy, {
      method: "POST",
      headers: {
        "User-Agent": ctx.userAgent,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ prodId: Number(prodId) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`getprodevents → ${res.status}`);
    events = (await res.json()) as ProdEvent[];
  } catch (err) {
    console.warn(`portland-opera: events for prod ${prodId} failed:`, err);
    return { performances: [], isOpera: false };
  }
  if (!Array.isArray(events) || events.length === 0) return { performances: [], isOpera: false };

  const isOpera = events.some((e) => (e.Category ?? "").toLowerCase() === "operas");
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const e of events) {
    const dt = parseStartDate(e.StartDate);
    if (!dt) continue;
    if (window.since && dt.date < window.since) continue;
    const key = `${dt.date}|${dt.time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date: dt.date,
      time: dt.time,
      venue_room: e.Venue?.Name?.trim() || null,
      status: dt.date < today ? "past" : "scheduled",
      ticket_url: e.TixUrl?.trim() || null,
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return { performances: out, isOpera };
}

/** `StartDate` is an ASP.NET "/Date(ms)/" epoch encoding the LOCAL wall-clock as
 *  if UTC (verified: 1793993400000 → 2026-11-06 19:30 UTC = the printed Nov. 6,
 *  7:30PM), so the UTC date+time components are the local date+time. */
function parseStartDate(value: string | undefined): { date: IsoDate; time: string | null } | null {
  const ms = value?.match(/\/Date\((\d+)\)\//)?.[1];
  if (!ms) return null;
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return { date: iso.slice(0, 10) as IsoDate, time: iso.slice(11, 16) };
}

/** The detail page prints "In Italian with English captions". */
function languageCode(html: string): RawProduction["language"] {
  const first = html.match(/\bIn\s+([A-Za-z]+)\s+with\s+English\b/i)?.[1]?.toLowerCase();
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
