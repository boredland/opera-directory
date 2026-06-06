import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Washington National Opera (`spielplan-html` strategy) — the Tier-1 US opera
 * company (US/English) that performs its mainstage season in the Kennedy Center
 * Opera House (chamber/family operas in the Terrace Theater). WNO has no
 * standalone site: its season lives inside kennedy-center.org, a large
 * multi-genre venue that also programs the NSO, ballet, theater, jazz, comedy
 * and the Millennium Stage. So the scrape has to (1) read the Kennedy Center
 * event feed, (2) isolate the WNO productions, and (3) keep only the operas.
 *
 * Source. The site is an Optimizely/Episerver CMS behind a Cloudflare managed
 * challenge — a plain fetch and the proxy's stealth render both get the
 * challenge page, so every request routes through the proxy's FlareSolverr path
 * (`&solve=1`; set `proxy: true` on the house). Two legs:
 *   - Listing: the calendar SPA's own backend, `GET /ace-api/events?startDate=
 *     &endDate=` (discovered in calendar-bundle.js: `aceCalendarAPIRoute =
 *     "ace-api/events"`, `apiDateFormat = "YYYY-MM-DD"`). It returns one JSON
 *     object PER PERFORMANCE across every genre, with `presenter`, `eventDate`
 *     (local ISO + TZ offset), `location` (the room), `viewDetailCtaUrl` and an
 *     `eventGroupId` that ties a run's nights together. FlareSolverr wraps the
 *     JSON in an HTML `<pre>`, so the body is unwrapped + entity-decoded here.
 *     WNO filter: `presenter` (or the `/wno/` detail URL) names Washington
 *     National Opera — this drops the NSO/ballet/theater/jazz noise.
 *   - Detail: each WNO run's `viewDetailCtaUrl` (`/wno/home/{season}/{slug}/`)
 *     is SSR HTML carrying the composer + cast + creative team (no JSON-LD).
 *     The composer lives in the Program section as a `Music by {Composer} /
 *     Libretto by …` line — REQUIRED, and the opera gate: WNO's non-opera
 *     billings under the same presenter (galas, studio open houses, recitals,
 *     simulcasts) carry no such line and drop out. Cast/creative come in two
 *     markup variants (a rich-text `Name, Role` list, or a structured
 *     `cast-bio`/`cast-member` block); both are parsed. The ENGLISH function
 *     labels are mapped to our slugs INSIDE this adapter (see CREATIVE_FUNCTIONS).
 *
 * Detail pages are unpublished once a run is past (they 404), so the live leg
 * only ever yields the current + announced operas — exactly the announced-future
 * job. `backfill` appends Wikidata for the deep past (thin for this company).
 */

const BASE = "https://www.kennedy-center.org";
const EVENTS_API = `${BASE}/ace-api/events`;

/** Washington National Opera on Wikidata — the current opera COMPANY (Q386613),
 *  not the former company (Q7972071) or the disambiguation page (Q7972072).
 *  Verified via wbsearchentities: Q386613 = "Washington National Opera",
 *  description "opera company in Washington D.C., United States" (P17 = Q30 USA,
 *  P159 = Q61 Washington, D.C.). */
const WIKIDATA_QID = "Q386613";

/** English creative-team function labels → our canonical slugs. A label the map
 *  doesn't know is dropped rather than guessed; the sung cast lives separately. */
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

interface AceEvent {
  name?: string;
  presenter?: string;
  eventDate?: string;
  location?: string;
  viewDetailCtaUrl?: string;
  eventGroupId?: number;
  cancelled?: boolean;
  soldOut?: boolean;
  synopsis?: string;
  thumbnail?: string;
}

export async function scrapeWashingtonNationalOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const events = await fetchWnoEvents(ctx, window);
    for (const run of groupRuns(events)) {
      try {
        const prod = await buildProduction(run, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`washington-national-opera: run ${run.detailUrl} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("washington-national-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("washington-national-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "washington-national-opera", productions };
}

/** Pull the Kennedy Center event feed across the scrape window and keep only the
 *  WNO-presented performances. The window's lower bound is `since` (or a couple
 *  of seasons back for an unbounded backfill); the upper bound reaches far enough
 *  ahead to catch the full announced future regardless of mode. */
async function fetchWnoEvents(ctx: FetchContext, window: ScrapeWindow): Promise<AceEvent[]> {
  const start = startDate(window);
  const end = new Date();
  end.setUTCFullYear(end.getUTCFullYear() + 2);
  const url = `${EVENTS_API}?startDate=${start}&endDate=${iso(end)}`;
  const events = parseEventFeed(await fetchSolved(url, ctx));
  return events.filter(isWno);
}

/** Earliest performance date the feed should reach. Backfill with no `since`
 *  walks two seasons back (the feed is current-catalog, not a deep archive — the
 *  deep past comes from Wikidata); incremental refreshes the recent past. */
function startDate(window: ScrapeWindow): string {
  if (window.since) return window.since;
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - (window.mode === "backfill" ? 2 : 0));
  if (window.mode === "incremental") d.setUTCMonth(d.getUTCMonth() - 2);
  return iso(d);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A WNO billing names the company in `presenter` (or sits under a `/wno/` detail
 *  URL). This is the company filter — it drops the NSO, ballet, theater, jazz and
 *  Millennium Stage events sharing the feed. The opera filter (composer) is later. */
function isWno(e: AceEvent): boolean {
  return (
    /washington national opera/i.test(stripHtml(e.presenter ?? "")) ||
    /^\/wno\//.test(e.viewDetailCtaUrl ?? "")
  );
}

interface Run {
  groupId: string;
  title: string;
  detailUrl: string;
  location: string | null;
  synopsis: string | null;
  image: string | null;
  events: AceEvent[];
}

/** Collapse the per-performance feed rows into one run per `eventGroupId` (its
 *  detail URL ties the nights together) — the production grain. */
function groupRuns(events: AceEvent[]): Run[] {
  const runs = new Map<string, Run>();
  for (const e of events) {
    const key = e.viewDetailCtaUrl || String(e.eventGroupId ?? "");
    if (!key) continue;
    let run = runs.get(key);
    if (!run) {
      run = {
        groupId: String(e.eventGroupId ?? key),
        title: stripHtml(e.name ?? ""),
        detailUrl: e.viewDetailCtaUrl ?? "",
        location: e.location ? stripHtml(e.location) : null,
        synopsis: e.synopsis ? stripHtml(e.synopsis) : null,
        image: e.thumbnail ? absolute(e.thumbnail) : null,
        events: [],
      };
      runs.set(key, run);
    }
    run.events.push(e);
  }
  return [...runs.values()];
}

async function buildProduction(
  run: Run,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const performances = parsePerformances(run, window);
  if (performances.length === 0 || !run.title) return null;

  // The detail page (unpublished once a run is past, so this can 404) carries
  // the composer + cast + creative. No composer ⇒ a non-opera WNO billing.
  const detail = run.detailUrl ? await fetchDetail(run.detailUrl, ctx) : null;
  const composer = detail ? parseComposer(detail) : null;
  if (!composer) return null;

  return {
    source_production_id: `washington-national-opera/${run.groupId}`,
    work_title: run.title,
    composer_name: composer,
    detail_url: absolute(run.detailUrl),
    image_url: run.image,
    synopsis: run.synopsis,
    creative_team: detail ? parseCreative(detail) : [],
    cast: detail ? parseCast(detail) : [],
    performances,
  };
}

async function fetchDetail(path: string, ctx: FetchContext): Promise<string | null> {
  const html = await fetchSolved(absolute(path), ctx);
  return /404 - File or directory not found/i.test(html) ? null : html;
}

/** Every feed row is one night: `eventDate` is a local ISO string with a TZ
 *  offset. Honors window.since; the room comes from the feed's `location`. */
function parsePerformances(run: Run, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const e of run.events) {
    const m = (e.eventDate ?? "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
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
      venue_room: e.location ? stripHtml(e.location) : run.location,
      status: e.cancelled
        ? "cancelled"
        : e.soldOut
          ? "sold_out"
          : date < today
            ? "past"
            : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** The composer is printed in the Program section as `Music by {Composer} /
 *  Libretto by …` (or a bare `Music by {Composer}`). Required — it's the opera
 *  gate, so a WNO non-opera billing returns null here and is dropped. */
function parseComposer(html: string): string | null {
  const m = html.match(/Music\s+by\s+([^<]+?)(?:\s*\/\s*Libretto\b|\s*<|$)/i);
  const name = m ? cleanText(m[1]) : "";
  return name || null;
}

// ── Cast & creative team (two SSR markup variants) ───────────────────────────
//
// Announcement-stage pages list both in one rich-text block: `<h3>Cast</h3>` /
// `<h3>Creative Team</h3>`, each followed by a `<p>` of `Name<span class="light">,
// Label</span>` lines split by `<br>`. Fully-built pages instead use structured
// blocks: the Cast as `cast-bio` entries (preheader `VOICE | ROLE`, name in an
// `h4-style` paragraph) and the Creative Team as `cast-member` entries (`h6-style`
// function label + `h4-style` name). Parse whichever a given page carries.

function parseCast(html: string): RawCredit[] {
  const structured = parseCastBio(html);
  if (structured.length > 0) return structured;
  return parseRichTextSection(html, "Cast").map(({ name, label }) => ({
    role: label || null,
    name,
  }));
}

function parseCreative(html: string): RawCredit[] {
  const structured = parseCreativeMembers(html);
  const rich = parseRichTextSection(html, "Creative Team").flatMap(({ name, label }) => {
    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    return fn ? [{ function: fn, name }] : [];
  });
  return dedupeCredits([...structured, ...rich]);
}

/** Structured cast: `<p class="…preheader">VOICE | ROLE</p>` then `<p class=
 *  "h4-style">Name</p>`. The role is the part after the `|` (the voice Fach
 *  precedes it); when there's no `|` the whole preheader is the role. */
function parseCastBio(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  const re = /class="[^"]*preheader[^"]*">([\s\S]*?)<\/p>\s*<p class="h4-style">([\s\S]*?)<\/p>/g;
  for (const [, pre, nameRaw] of html.matchAll(re)) {
    const name = cleanArtistName(nameRaw ?? "");
    if (!name) continue;
    const label = cleanText(stripHtml(pre ?? ""));
    const role = label.includes("|") ? label.split("|").pop()?.trim() || null : label || null;
    const key = `${role ?? ""}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name });
  }
  return out;
}

/** Structured creative team: `cast-member-item` blocks with an `h6-style`
 *  function label followed by an `h4-style` name (often a `<a>`-linked artist). */
function parseCreativeMembers(html: string): RawCredit[] {
  const block = sliceSection(html, "Creative Team");
  if (!block) return [];
  const out: RawCredit[] = [];
  const re = /<p class="h6-style"[^>]*>([\s\S]*?)<\/p>\s*<p class="h4-style"[^>]*>([\s\S]*?)<\/p>/g;
  for (const [, labelRaw, nameRaw] of block.matchAll(re)) {
    const fn = CREATIVE_FUNCTIONS[cleanText(stripHtml(labelRaw ?? "")).toLowerCase()];
    const name = cleanArtistName(nameRaw ?? "");
    if (fn && name) out.push({ function: fn, name });
  }
  return out;
}

/** Rich-text variant: under an `<h3>{heading}</h3>` a single `<p>` lists
 *  `Name<span class="light">, Label</span>` entries separated by `<br>`. */
function parseRichTextSection(html: string, heading: string): { name: string; label: string }[] {
  const re = new RegExp(`<h3[^>]*>\\s*${heading}\\s*</h3>\\s*<p[^>]*>([\\s\\S]*?)</p>`, "i");
  const block = html.match(re)?.[1];
  if (!block) return [];
  const out: { name: string; label: string }[] = [];
  for (const line of block.split(/<br\s*\/?>/i)) {
    const m = line.match(/^([\s\S]*?)<span[^>]*>\s*,?\s*([\s\S]*?)<\/span>/);
    if (!m) continue;
    const name = cleanText(stripHtml(m[1] ?? ""));
    const label = cleanText(stripHtml(m[2] ?? ""));
    if (name && label) out.push({ name, label });
  }
  return out;
}

/** The HTML region whose heading matches `name`, up to the next `</section>`. */
function sliceSection(html: string, name: string): string | null {
  const idx = html.search(new RegExp(`>\\s*${name}\\s*</h[12]>`, "i"));
  if (idx < 0) return null;
  const end = html.indexOf("</section>", idx);
  return html.slice(idx, end < 0 ? undefined : end);
}

function dedupeCredits(credits: RawCredit[]): RawCredit[] {
  const seen = new Set<string>();
  const out: RawCredit[] = [];
  for (const c of credits) {
    const key = `${c.function ?? ""}|${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ── Feed transport ───────────────────────────────────────────────────────────

/** The feed is JSON, but FlareSolverr returns it inside an HTML `<pre>` with the
 *  body entity-encoded; a non-challenged response may be raw JSON. Handle both. */
function parseEventFeed(body: string): AceEvent[] {
  const trimmed = body.trimStart();
  let json = trimmed;
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    const pre = body.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1];
    if (!pre) return [];
    json = decodeEntities(pre);
  }
  try {
    const data = JSON.parse(json);
    return Array.isArray(data) ? (data as AceEvent[]) : [];
  } catch {
    return [];
  }
}

/**
 * kennedy-center.org is behind a Cloudflare managed challenge — a plain fetch and
 * the proxy's stealth render both get the challenge page; only the proxy's
 * FlareSolverr path (`&solve=1`) clears it. So hand-build the proxy request here
 * rather than using fetchHtml/fetchRendered. The solver's challenge clearance is
 * intermittent (a cold cache returns the 403 challenge page), so retry a few
 * times. Without a configured proxy this falls back to a direct fetch (which will
 * fail the challenge — the house needs the proxy).
 */
async function fetchSolved(url: string, ctx: FetchContext): Promise<string> {
  const target = ctx.proxy ? `${ctx.proxy.url}?url=${encodeURIComponent(url)}&solve=1` : url;
  const headers: Record<string, string> = { "User-Agent": ctx.userAgent };
  if (ctx.proxy?.token) headers.Authorization = `Bearer ${ctx.proxy.token}`;

  let lastErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(target, { headers, signal: AbortSignal.timeout(120000) });
      const text = res.ok ? await res.text() : "";
      if (res.ok && !/Just a moment|challenge-platform/i.test(text.slice(0, 4000))) return text;
      lastErr = res.ok ? "cloudflare challenge" : `${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
  }
  throw new Error(`fetch failed: ${url} → ${lastErr}`);
}

function absolute(path: string): string {
  if (!path) return "";
  return path.startsWith("http") ? path : `${BASE}${path}`;
}

/** Decode entities and collapse whitespace (incl. trailing nbsp on names). */
function cleanText(value: string | undefined | null): string {
  return decodeEntities(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A name cell can be an `<a>`-linked artist whose accessibility text ("Learn
 *  More about") precedes the name; drop the visually-hidden span before stripping. */
function cleanArtistName(html: string): string {
  return cleanText(
    stripHtml(html.replace(/<span[^>]*visually-hidden[^>]*>[\s\S]*?<\/span>/gi, "")),
  );
}
