import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * New National Theatre, Tokyo (NNTT) — Japan's national centre for the
 * performing arts, here scoped to its OPERA wing (`json-api` strategy). NNTT is
 * multi-genre (opera / ballet / dance / drama), so the whole adapter is gated to
 * opera two ways: every item carries a `categories[].label`, and we keep only
 * `"Opera"`; and we additionally REQUIRE a composer, which drops the opera-genre
 * recitals / aria concerts / opera-on-screen items that have no staged work.
 *
 * The English site (`/english/`) is a static shell whose production list is a
 * single Movable Type Data API export at `/english/api/data.json` — one ~12 MB
 * file with every production across all four genres (no pagination), each a
 * Movable Type entry with rich `customFields`. We read that file once and parse
 * the opera entries; everything we need is English and pre-structured:
 *   - composer — from the `productions_complement` HTML, the "Music by {name}"
 *     (or "Composed by {name}") line. This is the opera gate (composerFromText is
 *     German-only and deliberately unused). No composer ⇒ a concert/recital,
 *     dropped.
 *   - creative team — `productions_staff[]` ({ Role, Name }); English `Role`
 *     labels mapped to our function slugs INSIDE this adapter (FUNCTION_KEYWORDS).
 *     NNTT's house term for the staging director is "Production".
 *   - cast — `productions_cast[]` ({ Role, Name }); role-bound entries only (the
 *     concert participant lists carry a name with no role and are skipped).
 *   - performances — `productions_datetime[].ProductionsDatetimeList`, each a
 *     `YYYYMMDDHHMMSS` local stamp → one dated night; `productions_theater` is the
 *     venue room (Opera Palace / Playhouse / The Pit). Honors `window.since`.
 *
 * The data.json is the complete announced set (future seasons + archive back to
 * the 2018/2019 season), so `incremental` and `backfill` read the same file;
 * `window.since` only bounds which performance dates survive. `backfill` then
 * appends Wikidata premieres for the deep past the export doesn't reach.
 */

const BASE = "https://www.nntt.jac.go.jp";
const DATA_URL = `${BASE}/english/api/data.json`;

/** New National Theatre Tokyo on Wikidata — Q1056064, "opera house in Tokyo,
 *  Japan". Verified via wbsearchentities (exact label match, sole result); it
 *  carries P4647 (location of first performance) premiere links, so the Wikidata
 *  backfill is non-empty. */
const WIKIDATA_QID = "Q1056064";

/** English `productions_staff[].Role` labels → our canonical function slugs.
 *  NNTT prints combined and house-specific labels ("Production" = the staging
 *  director; "Set and Costume Design", "Production and Costume Design") — combined
 *  labels fan out to every function they name. An unmapped label is dropped rather
 *  than guessed. Matching is substring-based against this table so the many
 *  one-off combinations resolve to the functions they contain. */
const FUNCTION_KEYWORDS: ReadonlyArray<[RegExp, string]> = [
  [/conductor/i, "conductor"],
  [/chorus\s*master|chorus\s*direct/i, "chorus-master"],
  [/\bproduction\b|stage\s*direct|\bstaging\b|\bdirector\b|\bdirection\b/i, "director"],
  [/choreograph/i, "choreographer"],
  [/set\b|scenic|stage\s*design/i, "set-designer"],
  [/costume/i, "costume-designer"],
  [/lighting/i, "lighting"],
  [/video|projection/i, "video-designer"],
  [/dramaturg/i, "dramaturgy"],
];

const VENUE_ROOMS = new Set(["Opera Palace", "Playhouse", "The Pit"]);

/** Movable Type Data API export shapes (only the fields we read). */
interface MtCustomField {
  basename?: string;
  value?: unknown;
}
interface MtCategory {
  label?: string;
}
interface MtEntry {
  title?: string;
  basename?: string;
  permalink?: string;
  categories?: MtCategory[];
  customFields?: MtCustomField[];
}
interface MtDataResponse {
  items?: MtEntry[];
}

interface StaffRow {
  ProductionsStaffName?: string;
  ProductionsStaffRole?: string;
}
interface CastRow {
  ProductionsCastName?: string;
  ProductionsCastRole?: string;
}
interface DatetimeRow {
  ProductionsDatetimeList?: string;
}

export async function scrapeNewNationalTheatreTokyo(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const data = await fetchJson<MtDataResponse>(DATA_URL, ctx);
    for (const entry of data.items ?? []) {
      if (!isOpera(entry)) continue;
      try {
        const prod = parseProduction(entry, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`new-national-theatre-tokyo: entry ${entry.basename} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("new-national-theatre-tokyo: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("new-national-theatre-tokyo: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "new-national-theatre-tokyo", productions };
}

function isOpera(entry: MtEntry): boolean {
  return (entry.categories ?? []).some((c) => c.label === "Opera");
}

function parseProduction(entry: MtEntry, window: ScrapeWindow): RawProduction | null {
  const fields = customFields(entry);
  const complement = stripHtml(decodeEntities(asString(fields.productions_complement)));

  const composer = parseComposer(complement);
  // No composer ⇒ a recital / aria concert / opera-on-screen, not a staged opera.
  if (!composer) return null;

  const title = cleanTitle(entry.title);
  if (!title) return null;

  const performances = parsePerformances(fields, window);
  if (performances.length === 0) return null;

  const season = asString(fields.productions_season).trim() || null;

  return {
    source_production_id: `new-national-theatre-tokyo/${entry.basename ?? title}`,
    work_title: title,
    composer_name: composer,
    premiere_season: season,
    is_revival: !/new\s+production/i.test(complement),
    detail_url: detailUrl(entry.permalink),
    creative_team: parseCreative(fields),
    cast: parseCast(fields),
    performances,
  };
}

/** Composer from the complement's "Music by {name}" / "Composed by {name}" line.
 *  Cuts at the trailing form/language clauses ("Opera in 2 Acts", "Sung in …"). */
function parseComposer(complement: string): string | null {
  const m = complement.match(/\b(?:Music|Composed)\s+(?:and\s+Libretto\s+)?by\s+([^,(]+)/i);
  if (!m?.[1]) return null;
  const name = m[1]
    .replace(
      /\b(Opera|Music\s*Drama|Sung|Libretto|Comedy|Comique|Operetta|Act|Acts|Prologue)\b[\s\S]*$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  return name || null;
}

/** Trim the whitespace and the *wrapping* quote pair NNTT puts around work titles
 *  (`title` is often ` "Tosca" `), without stripping inner quotes from titles like
 *  `Biwako Hall "The Twelve Months"`. */
function cleanTitle(raw: string | undefined): string {
  const text = stripHtml(decodeEntities(raw ?? "")).trim();
  const wrapped = text.match(/^"([^"]*)"$/) ?? text.match(/^'([^']*)'$/);
  return (wrapped?.[1] ?? text).trim();
}

function parseCreative(fields: Record<string, unknown>): RawCredit[] {
  const rows = parseRowArray<StaffRow>(fields.productions_staff);
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = clean(row.ProductionsStaffName);
    if (!name) continue;
    for (const fn of mapFunctions(row.ProductionsStaffRole)) {
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ function: fn, name });
    }
  }
  return out;
}

function parseCast(fields: Record<string, unknown>): RawCredit[] {
  const rows = parseRowArray<CastRow>(fields.productions_cast);
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = clean(row.ProductionsCastName);
    const role = clean(row.ProductionsCastRole);
    // Role-bound entries only; nameless rows and the bare participant lists on
    // concert items (name, no role) are not character cast.
    if (!name || !role) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name });
  }
  return out;
}

/** Performances are the `productions_datetime[]` nights, each a local
 *  `YYYYMMDDHHMMSS` stamp. The venue room is the production-level
 *  `productions_theater`. Honors window.since. */
function parsePerformances(
  fields: Record<string, unknown>,
  window: ScrapeWindow,
): RawPerformance[] {
  const room = asString(fields.productions_theater).trim();
  const venue = VENUE_ROOMS.has(room) ? room : room || null;
  const today = new Date().toISOString().slice(0, 10);

  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const row of parseRowArray<DatetimeRow>(fields.productions_datetime)) {
    const stamp = (row.ProductionsDatetimeList ?? "").trim();
    const m = stamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) continue;
    const [, y, mo, d, hh, mm] = m;
    const date = `${y}-${mo}-${d}` as IsoDate;
    const time = `${hh}:${mm}`;
    if (window.since && date < window.since) continue;
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }

  // Some past archive entries drop the per-night list; seed the single start date
  // so the production still carries one dated performance.
  if (out.length === 0) {
    const start = asString(fields.productions_start).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && (!window.since || start >= window.since)) {
      out.push({
        date: start as IsoDate,
        venue_room: venue,
        status: start < today ? "past" : "scheduled",
      });
    }
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Map an English staff `Role` label (possibly a combined "Set and Costume
 *  Design") to every canonical function slug it names. */
function mapFunctions(label: string | undefined): string[] {
  const text = clean(label);
  if (!text) return [];
  const fns: string[] = [];
  for (const [re, fn] of FUNCTION_KEYWORDS) {
    if (re.test(text) && !fns.includes(fn)) fns.push(fn);
  }
  return fns;
}

function customFields(entry: MtEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of entry.customFields ?? []) {
    if (f.basename) out[f.basename] = f.value;
  }
  return out;
}

/** Custom-field row arrays arrive as a JSON string (occasionally already an
 *  array). Empty placeholder rows (`flcf_row_is_null`) are kept here and filtered
 *  by the per-field name/role checks. */
function parseRowArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function clean(value: string | undefined): string {
  return stripHtml(decodeEntities(value ?? "")).trim();
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The export's permalinks point at the CMS host; rewrite to the public host. */
function detailUrl(permalink: string | undefined): string | null {
  if (!permalink) return null;
  return permalink.replace(/^https?:\/\/cms\.nntt\.jac\.go\.jp/, BASE);
}
