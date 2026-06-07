import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Gran Teatre del Liceu, Barcelona (`json-api` strategy) — Catalonia's leading
 * opera house. The Drupal 10 site renders its `/en/whats-on` listing entirely
 * client-side from a single static JSON file the front-end fetches:
 * `programme.json`. That file carries EVERY programmed item (~219, the full
 * archive the ticketing system reaches plus the announced future) keyed by node
 * id, each with a multilingual `categories` taxonomy, `title`, the composer in
 * `subtitle`, and dated `sessions[]` (one row per night, unix-epoch `date`).
 *
 * Opera is decided by the house's own taxonomy: we keep only the "Opera"
 * category (id 9) and drop everything else (concerts/recitals, ballet, "Opera in
 * concert version" (id 3049), Petit Liceu family, micro-operas, external
 * promoters, lectures). The composer (`subtitle`) is REQUIRED, which also drops
 * the cycle-package rows (e.g. "Der Ring des Nibelungen") that carry no sessions.
 *
 * The listing JSON has no credits, so each kept production's detail page (the
 * `url.en` slug, e.g. `/en/lohengrin`) is fetched once for cast + creative team.
 * Credits live in the `field-2024-artistic-profile` <dl> (<dt>label</dt><dd>name
 * </dd>); cast in the `field-artists` <dl> (role-name + artist). The conductor
 * and chorus-master are encoded specially: the "Orchestra …" profile item's <dd>
 * is the conductor and the "Choir/Chorus …" item's <dd> the chorus-master (both
 * prefixed "Conductor"/"Director"). Spanish/Catalan AND English labels are mapped
 * in-adapter (the detail page language follows the requested locale).
 *
 * Because the single JSON call already carries the whole archive, the window only
 * gates which performances are emitted: incremental keeps the future plus a
 * rolling recent-past refresh; backfill keeps everything back to `window.since`
 * and appends Wikidata for deeper history the listing doesn't reach.
 */

const BASE = "https://www.liceubarcelona.cat";
const PROGRAMME_JSON = `${BASE}/sites/default/files/programme.json`;
/** Gran Teatre del Liceu on Wikidata — the opera HOUSE/building (Q1130050, P31 =
 *  opera house Q153562), verified via wbsearchentities. Chosen over the separate
 *  "opera company" entity Q118492617 (P31 = opera company Q20819922): the house
 *  QID carries 16 P4647/P272-linked works vs the company's 2, and the wikidata
 *  strategy keys on those two relations. (Q27505825 is an Adrià Gual artwork.) */
const WIKIDATA_QID = "Q1130050";

/** The house's own category id for staged opera. Everything else (concerts,
 *  ballet, Petit Liceu, micro-operas, external promoters, lectures) is dropped. */
const OPERA_CATEGORY_ID = "9";
/** "Opera in concert version" — sung, not staged — dropped even within opera. */
const CONCERT_VERSION_CATEGORY_ID = "3049";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/** Liceu sits in the Europe/Madrid civil-time zone; sessions are stored as UTC
 *  epoch seconds, so local date/time is derived against this zone. */
const TIMEZONE = "Europe/Madrid";

/** Spanish/Catalan/English `artistic-profile` labels → canonical function slugs.
 *  Matched on a normalized (lowercased, accent-light) label; an unmapped label is
 *  dropped rather than guessed. Conductor and chorus-master are handled separately
 *  off the Orchestra/Choir items (see parseProfile), since those are not labelled
 *  by function but by ensemble. */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/^direccio(?:n)? musical|^musical direction$|^director$/i, "conductor"],
  [/direccio(?:n)? d['’ ]?escena|stage direction|^direction$/i, "director"],
  [/escenografi|set design|scenograph/i, "set-designer"],
  [/vestuari|vestuario|costume/i, "costume-designer"],
  [/il·?luminaci|iluminaci|^lighting/i, "lighting"],
  [/coreografi|choreograph/i, "choreographer"],
  [/dramaturg/i, "dramaturgy"],
];

interface ProgrammeJson {
  productions: Record<string, ProgrammeProduction>;
}

interface Localized {
  ca?: string | null;
  es?: string | null;
  en?: string | null;
}

interface ProgrammeSession {
  date?: number | null;
}

interface ProgrammeProduction {
  id: string;
  categories?: Record<string, Localized> | null;
  title?: Localized | null;
  subtitle?: Localized | null;
  url?: Localized | null;
  main_image?: string | null;
  sessions?: ProgrammeSession[] | null;
}

export async function scrapeGranTeatreDelLiceu(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const data = await fetchJson<ProgrammeJson>(PROGRAMME_JSON, ctx);
    const since = effectiveSince(window);

    for (const raw of Object.values(data.productions ?? {})) {
      try {
        const prod = await buildProduction(ctx, raw, since);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`gran-teatre-del-liceu: production ${raw.id} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("gran-teatre-del-liceu: programme JSON scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("gran-teatre-del-liceu: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "gran-teatre-del-liceu", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

async function buildProduction(
  ctx: FetchContext,
  raw: ProgrammeProduction,
  since: IsoDate | null,
): Promise<RawProduction | null> {
  const categories = raw.categories ?? {};
  if (!(OPERA_CATEGORY_ID in categories) || CONCERT_VERSION_CATEGORY_ID in categories) return null;

  const composer = pick(raw.subtitle);
  if (!composer) return null;

  const title = pick(raw.title);
  if (!title) return null;

  const performances = parsePerformances(raw.sessions ?? [], since);
  if (performances.length === 0) return null;

  const path = raw.url?.en ?? raw.url?.es ?? raw.url?.ca ?? null;
  const detailUrl = path ? `${BASE}${path}` : null;

  let creative_team: RawCredit[] = [];
  let cast: RawCredit[] = [];
  if (detailUrl) {
    try {
      const html = await fetchHtml(detailUrl, ctx);
      creative_team = parseProfile(html);
      cast = parseCast(html);
    } catch (err) {
      console.warn(`gran-teatre-del-liceu: detail ${detailUrl} failed:`, err);
    }
  }

  return {
    source_production_id: `gran-teatre-del-liceu/${raw.id}`,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: detailUrl,
    image_url: raw.main_image ? `${BASE}${raw.main_image}` : null,
    creative_team,
    cast,
    performances,
  };
}

/** Sessions are unix epoch seconds; emit one performance per night in local
 *  (Europe/Madrid) date/time, honoring `since`. */
function parsePerformances(sessions: ProgrammeSession[], since: IsoDate | null): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const s of sessions) {
    if (typeof s.date !== "number") continue;
    const { date, time } = localDateTime(s.date * 1000);
    if (since && date < since) continue;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date: date as IsoDate,
      time,
      venue_room: VENUE,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

const VENUE = "Gran Teatre del Liceu";

const DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Local (Europe/Madrid) calendar date + HH:MM for a UTC epoch-ms instant. */
function localDateTime(ms: number): { date: string; time: string | null } {
  const date = DATE_FMT.format(ms);
  const time = TIME_FMT.format(ms).replace(/^24:/, "00:");
  return { date, time: /^\d{2}:\d{2}$/.test(time) ? time : null };
}

/**
 * Creative team from the `field-2024-artistic-profile` <dl>: <dt>label</dt>
 * <dd>name</dd> items. The conductor and chorus-master are NOT function-labelled
 * here — they hang off the ensemble items: an "Orchestra/Orquestra/Orquesta/
 * Symphony" item's <dd> is the conductor, a "Choir/Chorus/Cor/Coro" item's <dd>
 * the chorus-master, both with a leading "Conductor"/"Director" word stripped.
 * Everything else maps through CREATIVE_LABELS; an unmapped label is dropped.
 */
function parseProfile(html: string): RawCredit[] {
  const dl = html.match(
    /<dl class="field--name-field-2024-artistic-profile[^"]*"[^>]*>([\s\S]*?)<\/dl>/,
  )?.[1];
  if (!dl) return [];

  const out: RawCredit[] = [];
  const seen = new Set<string>();
  const add = (fn: string, name: string): void => {
    const clean = name.trim();
    if (!clean) return;
    const key = `${fn}|${clean}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ function: fn, name: clean });
  };

  for (const [, rawLabel, rawValue] of dl.matchAll(
    /<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g,
  )) {
    const label = stripHtml(rawLabel ?? "").replace(/[:.]\s*$/, "");
    const value = stripHtml(rawValue ?? "");
    if (!label || !value) continue;

    if (/orquestr|orquesta|orchestra|symphon|simf[oò]nic/i.test(label)) {
      for (const name of splitNames(stripEnsembleRole(value))) add("conductor", name);
      continue;
    }
    if (/\b(cor|coro|choir|chorus)\b/i.test(label)) {
      for (const name of splitNames(stripEnsembleRole(value))) add("chorus-master", name);
      continue;
    }

    const fn = mapLabel(label);
    if (!fn) continue;
    for (const name of splitNames(value)) add(fn, name);
  }
  return out;
}

/** Ensemble <dd>s carry the role as a function word either leading ("Conductor X",
 *  "Director, X") or trailing ("Pilar Paredes, conductor"); strip both so only the
 *  person name(s) remain. */
function stripEnsembleRole(value: string): string {
  return value
    .replace(/^(?:conductor|director|direcci[oó]n?|direcci[oó])[,\s]+/i, "")
    .replace(/[,\s]+(?:conductor|director|direcci[oó]n?|direcci[oó])\s*$/i, "")
    .trim();
}

function mapLabel(label: string): string | null {
  const norm = label.normalize("NFC");
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(norm)) return fn;
  return null;
}

/**
 * Cast from the `field-artists` <dl>: each item pairs a `field-role-name`
 * (sung character) with a `field-artist` (singer). The house lists alternate
 * casts as repeated role rows; all are kept as printed.
 */
function parseCast(html: string): RawCredit[] {
  const dl = html.match(/<dl class="field--name-field-artists[^"]*"[^>]*>([\s\S]*?)<\/dl>/)?.[1];
  if (!dl) return [];

  const out: RawCredit[] = [];
  const seen = new Set<string>();
  const re =
    /field--name-field-role-name[^>]*>([\s\S]*?)<\/div>[\s\S]*?field--name-field-artist [^>]*>([\s\S]*?)<\/div>/g;
  for (const [, rawRole, rawName] of dl.matchAll(re)) {
    const role = stripHtml(rawRole ?? "");
    const name = stripHtml(rawName ?? "");
    if (!role || !name) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name });
  }
  return out;
}

/** A credit <dd> may list several people; split on commas / " and " / " y " /
 *  " i " (Catalan). Drop institutional names that aren't individual performers. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+(?:and|y|i)\s+/i)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 2 &&
        !/\b(orquestr|orquesta|orchestra|cor del|coro del|choir|chorus|liceu)\b/i.test(s),
    );
}

/** Prefer English, then Spanish, then Catalan; trim the trailing NBSP the CMS leaves. */
function pick(loc: Localized | null | undefined): string | null {
  if (!loc) return null;
  const value = loc.en ?? loc.es ?? loc.ca ?? "";
  const clean = stripHtml(value).replace(/ /g, " ").trim();
  return clean || null;
}

/** Spanish opera seasons run roughly Sep–Jul: an Oct 2024 premiere is "2024/25". */
function seasonOf(date: IsoDate | null | undefined): string | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (!year || !month) return null;
  const start = month >= 8 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}
