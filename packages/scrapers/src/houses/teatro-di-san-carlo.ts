import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Teatro di San Carlo, Naples — Europe's oldest continuously active opera house
 * (`json-api` strategy). The site is a WordPress install whose shows live in a
 * `spettacoli` custom post type, exposed through the WP REST API at
 * `…/wp-json/wp/v2/spettacoli`. Opera, balletto, concerti and recital all share
 * that post type; the `categoria-spettacoli` taxonomy term 82 ("Opera") is the
 * discipline filter, and a "concert version" billing inside it is dropped too.
 *
 * Two host gotchas drive the choices below:
 *   - the whole site sits behind a botguard/hCaptcha challenge that a plain fetch
 *     (and even a stealth render) can't pass; only the fetch-proxy's FlareSolverr
 *     tier (`&solve=1`) clears it, returning the JSON wrapped in a `<pre>` block we
 *     unwrap. The gate is intermittent, so the fetch retries. `proxy: true` in
 *     houses.json wires `ctx.proxy` for this.
 *   - the default REST query returns only the *published/announced* shows (the
 *     future leg, ~6 operas); the deep past isn't in the API, so backfill comes
 *     from Wikidata (Q628491).
 *
 * Each spettacolo carries an ACF payload: `data_inizio`/`data_fine` (DD/MM/YYYY
 * run bounds) and a `layout` of `testo_semplice` blocks whose `testo` is a free
 * HTML body holding everything inline (no JSON-LD, no per-credit fields):
 *   - "Music by {X}" / "Musica di {X}" — composer, REQUIRED (the opera gate);
 *   - credit lines "Label | Name" whose EN/IT labels (Conductor/Direttore,
 *     Stage Director/Regia, …) map to canonical functions in CREATIVE_LABELS;
 *   - a "Cast" heading after which "Role | Singer (5, 8) / Singer (7, 10)" lines
 *     give the cast (per-night date hints stripped, alternates split on " / ");
 *   - per-night lines "Sunday 2026, June 14, h 17:00 – …" giving the dates; when
 *     absent we fall back to the data_inizio/data_fine run bounds.
 */

const API_BASE = "https://teatrosancarlo.it/en/wp-json/wp/v2";
const VENUE = "Teatro di San Carlo";
/** San Carlo on Wikidata — verified via wbsearchentities (it): "Teatro di San
 *  Carlo", opera house in Naples, Italy; 212 works link via P4647 (premiere
 *  here) / P272 (produced here). */
const WIKIDATA_QID = "Q628491";

/** The "Opera" term of the `categoria-spettacoli` taxonomy — the discipline gate
 *  that drops balletto / concerto / recital / chamber-music billings. */
const OPERA_CATEGORY_ID = 82;

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/** The challenge gate is intermittent on this host; retry the JSON fetch a few
 *  times with a short backoff between attempts (FlareSolverr needs to re-solve). */
const FETCH_RETRIES = 6;
const RETRY_BACKOFF_MS = 6000;

/**
 * Credit-function labels → canonical function keys, tested in order. The API
 * serves the page language (we read `/en/`), so English labels lead; the Italian
 * equivalents are folded in so the map survives a language flip. Chorus-master is
 * matched before the generic conductor rule, and director before set/costume.
 * Unmapped labels (e.g. "Director of the Ballet") are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/master of the (children )?chorus|maestro del coro/i, "chorus-master"],
  [/conductor|direttore|direzione musicale/i, "conductor"],
  [/stage director|director(?! of)|regia|regista/i, "director"],
  [/choreograph|coreograf/i, "choreographer"],
  [/lighting|disegno luci|^luci\b/i, "lighting"],
  [/costumes? designer|costumi/i, "costume-designer"],
  [/set designer|scenografia|^scene\b/i, "set-designer"],
  [/dramaturg|drammaturgia/i, "dramaturgy"],
];

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12,
};

interface AcfBlock {
  acf_fc_layout?: string;
  testo?: string;
}
interface Spettacolo {
  id: number;
  slug: string;
  link?: string;
  title?: { rendered?: string };
  "categoria-spettacoli"?: number[];
  acf?: {
    data_inizio?: string;
    data_fine?: string;
    annullato?: boolean;
    location?: string;
    immagine_verticale?: string;
    layout?: AcfBlock[];
  };
}

export async function scrapeTeatroDiSanCarlo(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);
    for (const sp of await fetchSpettacoli(ctx)) {
      if (!(sp["categoria-spettacoli"] ?? []).includes(OPERA_CATEGORY_ID)) continue;
      try {
        const prod = buildProduction(sp, since, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-di-san-carlo: ${sp.slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-di-san-carlo: spettacoli fetch failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-di-san-carlo: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-di-san-carlo", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** The default REST query returns the announced (published) shows — the future
 *  leg. The challenge gate on this host is intermittent and only the proxy's
 *  FlareSolverr tier clears it, so go through `solve=1` and retry a few times. */
async function fetchSpettacoli(ctx: FetchContext): Promise<Spettacolo[]> {
  const apiUrl = `${API_BASE}/spettacoli?per_page=100&orderby=date&order=desc`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS);
    try {
      const body = await solveFetch(apiUrl, ctx);
      return JSON.parse(unwrapPre(body)) as Spettacolo[];
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Fetch a URL through the proxy's FlareSolverr challenge-solver tier. Falls back
 *  to a plain fetch when no proxy is configured (dev) — which the gate will block,
 *  but keeps the adapter callable. */
async function solveFetch(url: string, ctx: FetchContext): Promise<string> {
  if (!ctx.proxy) {
    const res = await fetch(url, { headers: { "User-Agent": ctx.userAgent } });
    return res.text();
  }
  const target = `${ctx.proxy.url}?url=${encodeURIComponent(url)}&solve=1`;
  const headers: Record<string, string> = { "User-Agent": ctx.userAgent };
  if (ctx.proxy.token) headers.Authorization = `Bearer ${ctx.proxy.token}`;
  const res = await fetch(target, { headers, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`solve fetch failed: ${url} → ${res.status}`);
  return res.text();
}

/** FlareSolverr returns the solved page's DOM; a JSON API response lands inside a
 *  single `<pre>…</pre>`. Pull it out and decode the HTML entities it escaped. */
function unwrapPre(body: string): string {
  const m = body.match(/<pre>([\s\S]*?)<\/pre>/);
  if (!m?.[1]) throw new Error("challenge not solved (no <pre> payload)");
  return decodeEntities(m[1]);
}

function buildProduction(
  sp: Spettacolo,
  since: IsoDate | null,
  today: string,
): RawProduction | null {
  const testo = operaBody(sp);
  if (!testo) return null;

  const composer = parseComposer(testo);
  if (!composer) return null;

  // A concert-version billing inside the opera category is not a staged opera.
  if (/concert version|versione da concerto|in forma di concerto/i.test(testo)) return null;

  const title = cleanText(sp.title?.rendered ?? "");
  if (!title) return null;

  const performances = parsePerformances(testo, sp.acf, since, today);
  if (performances.length === 0) return null;

  return {
    source_production_id: `sancarlo:${sp.id}`,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: sp.link ?? null,
    image_url: sp.acf?.immagine_verticale ?? null,
    creative_team: parseCreativeTeam(testo),
    cast: parseCast(testo),
    performances,
  };
}

/** Join the `testo_semplice` ACF blocks into one plain-text body with `<br>`
 *  turned into newlines so the line-oriented label/date parsing works. */
function operaBody(sp: Spettacolo): string {
  const parts: string[] = [];
  for (const blk of sp.acf?.layout ?? []) {
    if (blk.acf_fc_layout === "testo_semplice" && blk.testo) {
      parts.push(decodeEntities(blk.testo.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")));
    }
  }
  return parts.join("\n");
}

/** Composer byline "Music by Francesco Cilea" / "Musica di …" — its absence marks
 *  a non-opera billing → drop (the opera gate). */
function parseComposer(testo: string): string | null {
  const m = testo.match(/(?:music by|musica di)\s+([^\n]+)/i);
  return m ? cleanText(m[1] ?? "") || null : null;
}

/** Creative team: "Label | Name" lines that appear before the "Cast" heading and
 *  whose label maps to a canonical function. Ensemble lines (orchestra, chorus,
 *  production credits) carry no "| " and are skipped. */
function parseCreativeTeam(testo: string): RawCredit[] {
  const head = testo.split(/\n\s*Cast\s*\n/i)[0] ?? testo;
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const [, rawLabel, rawName] of head.matchAll(/^\s*([^|\n]+?)\s*\|\s*([^\n]+)$/gm)) {
    const fn = mapFunction(cleanText(rawLabel ?? ""));
    if (!fn) continue;
    for (const person of splitNames(cleanText(rawName ?? ""))) {
      const key = `${fn}|${person}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ function: fn, name: person });
    }
  }
  return out;
}

/** Cast: "Role | Singer (5, 8) / Singer (7, 10)" lines after the "Cast" heading,
 *  up to the ensemble/production trailer. Alternates split on " / ", per-night
 *  date hints stripped. Rows whose label maps to a creative function (a stray
 *  chorus-master line) are skipped. */
function parseCast(testo: string): RawCredit[] {
  const after = testo.split(/\n\s*Cast\s*\n/i)[1];
  if (!after) return [];
  const body =
    after.split(/\n\s*(?:Orchestra|Production|Coproduction|Teatro di San Carlo \|)/i)[0] ?? after;
  const out: RawCredit[] = [];
  for (const [, rawRole, rawCell] of body.matchAll(/^\s*([^|\n]+?)\s*\|\s*([^\n]+)$/gm)) {
    const role = cleanText(rawRole ?? "");
    if (!role || mapFunction(role)) continue;
    for (const singer of splitCastSingers(cleanText(rawCell ?? ""))) {
      out.push({ role, name: singer });
    }
  }
  return out;
}

/** Performances from the per-night lines ("Sunday 2026, June 14, h 17:00 – …",
 *  with or without the comma after the year and either month/day order); when the
 *  body has none, fall back to the data_inizio/data_fine run bounds. */
function parsePerformances(
  testo: string,
  acf: Spettacolo["acf"],
  since: IsoDate | null,
  today: string,
): RawPerformance[] {
  const cancelled = acf?.annullato === true;
  const seen = new Set<string>();
  const out: RawPerformance[] = [];

  const push = (date: string, time: string | null) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (since && date < since) return;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      date: date as IsoDate,
      time,
      venue_room: VENUE,
      status: cancelled ? "cancelled" : date < today ? "past" : "scheduled",
    });
  };

  const re =
    /(\d{4})[,\s]+(?:([A-Za-z]+)[,\s]+(\d{1,2})|(\d{1,2})[,\s]+([A-Za-z]+))\s*,?\s*h\s*(\d{1,2})[:.](\d{2})/g;
  for (const [, year, monA, dayA, dayB, monB, hh, mm] of testo.matchAll(re)) {
    const month = MONTHS[(monA ?? monB ?? "").toLowerCase()];
    const day = Number.parseInt(dayA ?? dayB ?? "", 10);
    if (!month || !day) continue;
    push(`${year}-${pad(month)}-${pad(day)}`, `${pad(Number(hh))}:${mm}`);
  }

  if (out.length === 0) {
    for (const d of expandRun(acf?.data_inizio, acf?.data_fine)) push(d, null);
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/** Fallback dates from the DD/MM/YYYY run bounds: a single performance per day
 *  from data_inizio to data_fine inclusive (a coarse stand-in when the body lists
 *  no per-night lines). Capped so a malformed range can't loop unbounded. */
function expandRun(start?: string, end?: string): string[] {
  const s = parseDMY(start);
  const e = parseDMY(end) ?? s;
  if (!s || !e) return [];
  const out: string[] = [];
  for (let t = s.getTime(); t <= e.getTime() && out.length < 90; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function parseDMY(value?: string): Date | null {
  const m = value?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A creative-credit value may list several people; split on commas / " e " / " and ".
 *  Drop ensemble names — only individual performers belong in the graph. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+e\s+|\s+and\s+/)
    .map((s) => s.trim())
    .filter(
      (s) => s.length >= 2 && !/orchestra|\bcoro\b|chorus|filarmonica|ensemble|ballet/i.test(s),
    );
}

/** A cast cell lists one or more singers, each optionally trailed by its
 *  performance dates in parens ("Anna Pirozzi (5, 8, 11)"); alternates separated
 *  by " / ". Strip the date hints and the disambiguation marks (♮ ♭ # *). */
function splitCastSingers(cell: string): string[] {
  return cell
    .split(/\s*\/\s*/)
    .map((s) =>
      s
        .replace(/\s*\([^)]*\)\s*/g, " ")
        .replace(/[♮♭♯#*]+/g, " ")
        .trim(),
    )
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|chorus|ensemble/i.test(s));
}

/** Italian opera seasons run autumn→summer; San Carlo's opens in the autumn, so a
 *  June 2026 performance belongs to "2025/26". */
function seasonOf(date?: string): string | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (!year || !month) return null;
  const start = month >= 9 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip residual entities/marks, collapse whitespace, drop a trailing colon. */
function cleanText(text: string): string {
  return decodeEntities(text)
    .replace(/[♮♭♯]+/g, " ")
    .replace(/[:|]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}
