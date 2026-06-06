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
 * Rossini Opera Festival, Pesaro (`spielplan-html` strategy, WordPress).
 *
 * FESTIVAL — Italy's annual Rossini-only festival; one edition staged each
 * August, the site empty of programme the rest of the year. The live leg is the
 * CURRENT edition only: each edition lives at `/archivio/stagione-{YEAR}/`, an
 * index linking every programme item as `/archivio/stagione-{YEAR}/{slug}/`. The
 * deep history of past editions isn't a walkable archive (the /archivio/ index
 * surfaces only the current edition), so backfill comes from Wikidata.
 *
 * Detail pages are server-rendered. The work is described by an Italian genre
 * line ("Farsa comica in un atto di {librettist}", "Tragédie lyrique in tre atti
 * …", "Dramma giocoso …", "Burletta per musica …"); we keep an item only when
 * that line carries a staged-opera genre marker — this drops the festival's
 * concerts, recitals ("Concerti di belcanto", "Rossinimania"), galas
 * ("Flórez 30") and the sacred "Stabat Mater". The staged works are all by
 * Rossini, so composer defaults to Gioachino Rossini unless an explicit
 * "Musica di {X}" byline says otherwise (the "di {name}" after the genre is the
 * librettist, not the composer — composerFromText would mis-grab it).
 *
 * Dates: `<div class="dataOpera">` lists the days for one (or more) month +
 * time, e.g. "16, 19 agosto, ore 11.00" or "12, 15 agosto ore 20.00, 18 agosto
 * ore 12.00". Venue: `<li class="luogoOpera">` (Teatro Rossini / Auditorium
 * Scavolini / Vitrifrigo Arena). Credits + cast are `Label <b>NAME</b>` rows
 * within the content `<p>` blocks: rows above the `<h2>Interpreti</h2>` heading
 * are the creative team (Italian labels mapped below), rows under it are the
 * sung cast (character role → singer).
 */

const BASE = "https://www.rossinioperafestival.it";
/** Rossini Opera Festival on Wikidata — verified via wbsearchentities; P136
 *  genre = opera (Q1344) + festival (Q9730), P17 = Italy. */
const WIKIDATA_QID = "Q1592865";

const DEFAULT_COMPOSER = "Gioachino Rossini";

/** Staged-opera genre markers on the work's description line. Matches Rossini's
 *  dramatic forms; excludes the sacred Stabat Mater ("per soli, coro e
 *  orchestra"), instrumental/vocal concerts ("concerto"), and galas. */
const OPERA_GENRE =
  /\b(dramma\s+giocoso|farsa\s+(comica|giocosa)|burletta\s+per\s+musica|tragéd(?:ie|ia)\s+lyrique|melodramma\s+(?:giocoso|tragico|eroico|serio)|opéra|opera\s+(?:seria|buffa|semiseria)|azione\s+tragica|commedia\s+per\s+musica)\b/i;

/** Italian creative-function labels → canonical function keys, tested in order.
 *  Any label containing "regia" is first and foremost a director credit (the
 *  site combines it: "Regia, scene e costumi", "Elementi scenici e regia",
 *  "Ripresa della regia"), so it precedes the set/costume rules. */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/^direttore/i, "conductor"],
  [/^maestro del coro/i, "chorus-master"],
  [/regia/i, "director"],
  [/coreograf/i, "choreographer"],
  [/^videodesign|^video\b|^disegno video/i, "video-designer"],
  [/^luci\b|^disegno luci|^disegno delle luci/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi/i, "costume-designer"],
  [/^scene/i, "set-designer"],
];

export async function scrapeRossiniOperaFestivalPesaro(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const season = await findCurrentSeason(ctx);
    if (season) {
      for (const slug of season.slugs) {
        try {
          const prod = await buildProduction(ctx, season.year, slug, window);
          if (prod) productions.push(prod);
        } catch (err) {
          console.warn(`rossini-opera-festival-pesaro: ${slug} failed:`, err);
        }
      }
    } else {
      console.warn("rossini-opera-festival-pesaro: no current edition index found");
    }
  } catch (err) {
    console.warn("rossini-opera-festival-pesaro: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("rossini-opera-festival-pesaro: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "rossini-opera-festival-pesaro", productions };
}

/** The current edition's year (August festival → current calendar year, with the
 *  next year as fallback once an edition publishes early). Returns the first
 *  `/archivio/stagione-{YEAR}/` index that exists, with its production slugs. */
async function findCurrentSeason(
  ctx: FetchContext,
): Promise<{ year: number; slugs: string[] } | null> {
  const thisYear = new Date().getUTCFullYear();
  for (const year of [thisYear, thisYear + 1, thisYear - 1]) {
    try {
      const html = await fetchHtml(`${BASE}/archivio/stagione-${year}/`, ctx);
      const slugs = parseIndex(html, year);
      if (slugs.length > 0) return { year, slugs };
    } catch {
      // try next candidate year
    }
  }
  return null;
}

function parseIndex(html: string, year: number): string[] {
  const slugs = new Set<string>();
  const re = new RegExp(`/archivio/stagione-${year}/([a-z0-9-]+)/`, "gi");
  for (const [, slug] of html.matchAll(re)) if (slug) slugs.add(slug);
  return [...slugs];
}

async function buildProduction(
  ctx: FetchContext,
  year: number,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/archivio/stagione-${year}/${slug}/`;
  const html = await fetchHtml(url, ctx);

  const content = sliceContent(html);
  const title = stripHtml(content.match(/class="titoloNero"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!title) return null;

  // Keep only staged opera: the genre line must carry a dramatic-opera marker.
  const genreLine = parseGenreLine(content);
  if (!OPERA_GENRE.test(genreLine)) return null;

  const performances = parseDates(content, year, window);
  if (performances.length === 0) return null;

  // The genre marker already excludes concerts/galas/sacred works, so cast may be
  // legitimately empty — the Accademia young-artists staging bills "Allievi
  // dell'Accademia" with no per-role cast. Keep it; don't require named cast.
  const { creative, cast } = parseCredits(content);

  return {
    source_production_id: `${year}/${slug}`,
    work_title: title,
    composer_name: parseComposer(genreLine),
    premiere_season: String(year),
    is_revival: /riallestimento|ripresa|ripr\./i.test(content),
    detail_url: url,
    image_url: html.match(/class="testataSingola">[\s\S]*?<img src="([^"]+)"/)?.[1] ?? null,
    creative_team: creative,
    cast,
    performances,
  };
}

/** Narrow to the production article so the nav menu's repeated labels (which
 *  also contain "Direttore"/"Costumi") can't pollute the credit parse. */
function sliceContent(html: string): string {
  const start = html.indexOf('class="contenuto"');
  if (start === -1) return html;
  const rest = html.slice(start);
  // The work description, credits and cast sit in the article's aside block; cut
  // at its close, not at the "CONTENUTO COLONNA" comment (which precedes it).
  const end = rest.indexOf("</aside>");
  return end === -1 ? rest : rest.slice(0, end);
}

/** The work's genre/byline text — the description block that opens the article
 *  body (after the title/date/venue header and social-sharing links), up to the
 *  first credit separator (`<hr>`). Holds "{genre} in {n} atti di {librettist}"
 *  and, when present, a "Musica di {composer}" line. */
function parseGenreLine(content: string): string {
  const afterShare = content.replace(/[\s\S]*?social-sharing[\s\S]*?<\/ul>/i, "");
  const head = afterShare.split(/<hr\s*\/?>/i)[0] ?? "";
  return decodeEntities(stripHtml(head));
}

/** Composer defaults to Rossini (the festival stages only his operas); an
 *  explicit "Musica di {X}" byline overrides it. The "di {name}" after the
 *  genre word is the librettist, so we never read the composer from there. */
function parseComposer(genreLine: string): string {
  const m = genreLine.match(/Musica di\s+([A-ZÀ-Ý][^,(]+?)(?:\s+Edizione|\s*$|,)/i);
  const name = m?.[1]?.trim();
  return name && name.length >= 3 ? name : DEFAULT_COMPOSER;
}

const MONTHS: Record<string, string> = {
  gennaio: "01",
  febbraio: "02",
  marzo: "03",
  aprile: "04",
  maggio: "05",
  giugno: "06",
  luglio: "07",
  agosto: "08",
  settembre: "09",
  ottobre: "10",
  novembre: "11",
  dicembre: "12",
};

/**
 * `<div class="dataOpera">` carries the day-list per month + time, e.g.
 * "16, 19 agosto, ore 11.00" (two dates, one shared time) or, with per-date
 * times, "12, 15 agosto ore 20.00, 18 agosto ore 12.00, 20 agosto, ore 20.00".
 *
 * Each "{days} {month} ore HH.MM" unit is one entry: the days bind to the month
 * and time that follow them, up to the next entry. We tokenize the string into
 * day-numbers, month names, and times in order, then flush the pending day list
 * whenever a month is seen — pairing it with the time that follows that month.
 */
function parseDates(content: string, year: number, window: ScrapeWindow): RawPerformance[] {
  const block = content.match(/class="dataOpera">([\s\S]*?)<\/div>/)?.[1];
  if (!block) return [];
  const text = decodeEntities(stripHtml(block)).toLowerCase();

  const venue = parseVenue(content);
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  // Token stream: a time ("ore HH.MM"), a month name, or a bare day number.
  // Order matters — match times first so their minute digits aren't read as days.
  const monthAlt = Object.keys(MONTHS).join("|");
  const tokenRe = new RegExp(`ore\\s*(\\d{1,2})[.:](\\d{2})|\\b(${monthAlt})\\b|(\\d{1,2})`, "g");

  type Pending = { day: string; month: string | null };
  let pending: Pending[] = [];
  for (const m of text.matchAll(tokenRe)) {
    if (m[1]) {
      // A time — apply it to every pending day that doesn't yet have its own
      // month/time committed, then emit them.
      const time = `${m[1].padStart(2, "0")}:${m[2]}`;
      for (const p of pending) {
        if (p.month) emit(p.day, p.month, time);
      }
      pending = pending.filter((p) => !p.month);
    } else if (m[3]) {
      const month = MONTHS[m[3]] ?? null;
      for (const p of pending) if (!p.month) p.month = month;
    } else if (m[4]) {
      pending.push({ day: m[4], month: null });
    }
  }
  // Flush any days whose time we never saw (date kept, time null).
  for (const p of pending) if (p.month) emit(p.day, p.month, null);

  function emit(day: string, month: string, time: string | null): void {
    const date = `${year}-${month}-${day.padStart(2, "0")}` as IsoDate;
    const key = `${date}|${time}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (window.since && date < window.since) return;
    out.push({ date, time, venue_room: venue, status: date < today ? "past" : "scheduled" });
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

function parseVenue(content: string): string | null {
  const m = content.match(/class="luogoOpera">([\s\S]*?)<\/li>/);
  return m ? stripHtml(m[1] ?? "").replace(/\s*>\s*$/, "") || null : null;
}

/**
 * Credits + cast as `Label <b>NAME</b>` (or `<strong>`) rows. The
 * `<h2>Interpreti</h2>` heading is the boundary: rows before it are the creative
 * team (Italian function labels), rows under it are the sung cast (character role
 * → singer). A label may carry several comma-separated names — emit one credit
 * per person. Ensemble lines (orchestra/coro, all-caps with no label) are skipped.
 */
function parseCredits(content: string): { creative: RawCredit[]; cast: RawCredit[] } {
  const idx = content.search(/<h2[^>]*>\s*Interpreti/i);
  const creativeSeg = idx === -1 ? content : content.slice(0, idx);
  const castSeg = idx === -1 ? "" : content.slice(idx);

  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  // Above "Interpreti": only mapped creative functions are kept (unlabeled
  // ensemble lines are dropped). Below it: a sung role unless the label is itself
  // a staff function ("Maestro del Coro"), which belongs in the creative team.
  for (const { label, name } of creditRows(creativeSeg)) {
    const fn = mapFunction(label);
    if (fn) pushUnique(creative, seen, `${label}|${name}`, { function: fn, name });
  }
  for (const { label, name } of creditRows(castSeg)) {
    const fn = mapFunction(label);
    if (fn) pushUnique(creative, seen, `${label}|${name}`, { function: fn, name });
    else pushUnique(cast, seen, `${label}|${name}`, { role: label, name });
  }
  return { creative, cast };
}

/** Rows are "Label <b>NAME</b>" sharing a `<p>`, the labels separated only by the
 *  preceding name's closing tag. Walk each bolded name and read the plain text
 *  immediately before it as that row's label (back to the prior tag boundary),
 *  so a label following "</b>" isn't dropped; one row per person in a name list. */
function creditRows(seg: string): { label: string; name: string }[] {
  const rows: { label: string; name: string }[] = [];
  const re = /<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi;
  let prevEnd = 0;
  for (const m of seg.matchAll(re)) {
    const between = seg.slice(prevEnd, m.index ?? 0);
    prevEnd = (m.index ?? 0) + m[0].length;
    const label = decodeEntities(stripHtml(between.split(/<\/p>|<\/h2>/i).pop() ?? ""))
      .replace(/[:.]\s*$/, "")
      .trim();
    if (!label) continue;
    for (const name of splitNames(decodeEntities(stripHtml(m[1] ?? "")))) {
      rows.push({ label, name });
    }
  }
  return rows;
}

function pushUnique(out: RawCredit[], seen: Set<string>, key: string, credit: RawCredit): void {
  if (seen.has(key)) return;
  seen.add(key);
  out.push(credit);
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A credit value may list several people ("ELEONORA PERONETTI, PAOLO GEP
 *  CUCCO, DAVIDE LIVERMORE"); split on commas. Drop ensemble names (orchestra,
 *  coro, accademia) — they aren't individual performers we model. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+e\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|accademia|filarmonica|allievi/i.test(s));
}
