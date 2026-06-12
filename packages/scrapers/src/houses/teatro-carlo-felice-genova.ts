import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Teatro Carlo Felice, Genoa (`spielplan-html` strategy) — the fondazione lirica
 * Opera Carlo Felice Genova. The house plays opera (lirica), balletto, sinfonica,
 * musica da camera and a raft of festivals across one WordPress install whose
 * shows are a `show` custom post type tagged by a `discipline` taxonomy.
 *
 * That taxonomy IS the opera filter: the WP REST collection
 * `/wp-json/wp/v2/show?discipline=4` returns only the `lirica` (opera) shows —
 * one cheap call yields every staged opera across all seasons (≈49), with slug,
 * link and `season` term. Balletto, concerti, sinfonica and the festivals carry
 * their own discipline terms and never appear. We take that index, then fetch
 * each show's SSR detail page for the production facts the REST payload omits
 * (its `acf` block is unexposed and `content.rendered` lacks the calendar).
 *
 * Each `/spettacolo/{slug}/` detail page carries everything inline:
 *   - composer in `Musica di <strong>{X}</strong>` (a `<mark>` colour wrapper is
 *     stripped); older pages give it as "{form} … di {X}" prose — REQUIRED (the
 *     opera gate; productions with no resolvable composer are dropped);
 *   - performances in a `<table class="dkr-calendar-table">`: each row pairs a
 *     `dkr-calendar-table-date` cell ("DO 19/04/2026", optional "(Prima)" + a
 *     "Turno X" subscription label) with a `dkr-calendar-table-time` cell
 *     ("Ore HH:MM") and a buy cell whose vivaticket link / "Biglietti non più
 *     disponibili" wording gives the status;
 *   - creative team and cast as `<p>label<br><strong>Name</strong></p>` rows: a
 *     row whose label maps to a canonical function (Direttore, Regia, Scene e
 *     costumi, Luci, Maestro del Coro, …) is a creative credit; an `<em>Role</em>`
 *     row is a sung character → cast (per-night singer rotations like "(16, 18,
 *     20)" are flattened, the Accademia "*" marker dropped).
 *
 * Because the single REST index already spans the whole back-catalogue, the
 * window only gates which performances are emitted: incremental keeps the future
 * plus a rolling recent-past refresh; backfill keeps everything back to
 * `window.since` and appends Wikidata (Q2299021, ~39 works) for the deep history
 * predating the WordPress shows.
 */

const BASE = "https://operacarlofelicegenova.it";
/** The `lirica` discipline term — the house's own opera tag (verified against the
 *  `/wp-json/wp/v2/discipline` vocabulary: balletto=2, sinfonica=5, lirica=4). */
const SHOWS_API = `${BASE}/wp-json/wp/v2/show?discipline=4&per_page=100&_fields=slug,link`;
/** Opera Carlo Felice Genova on Wikidata — verified via wbsearchentities (it) →
 *  Special:EntityData/Q2299021: P31 = opera house (Q153562) + theatre (Q24354),
 *  P17 = Italy (Q38); 39 works link via P4647 (premiere here) / P272 (produced
 *  here), the production-bearing relations the SPARQL backfill walks. */
const WIKIDATA_QID = "Q2299021";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/**
 * Italian creative-function labels → canonical function keys, tested in order.
 * "Regia" is matched before the set/costume rules because the site combines it
 * ("Regia e scene"); chorus-master precedes the generic conductor rule so a
 * "Maestro del Coro" line isn't swallowed by "maestro …". Unmapped labels
 * (Regista assistente, Allestimento, …) yield no function and are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro/i, "chorus-master"],
  [/direttore|direzione musicale|maestro concertatore|maestro del coro/i, "conductor"],
  [/regia|staging|director/i, "director"],
  [/coreograf|movimenti coreografici/i, "choreographer"],
  [/disegno luci|^luci\b|^luce\b|lighting/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi|costumes/i, "costume-designer"],
  [/scenografia|^scene\b|sets?\b/i, "set-designer"],
  [/drammaturgia|dramaturgy/i, "dramaturgy"],
];

interface ShowIndexEntry {
  slug?: string | null;
  link?: string | null;
}

export async function scrapeTeatroCarloFeliceGenova(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);
    const detailUrls = await discoverOperaShows(ctx);

    for (const detailUrl of detailUrls) {
      try {
        const prod = await buildProduction(detailUrl, ctx, since, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-carlo-felice-genova: ${detailUrl} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-carlo-felice-genova: show scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-carlo-felice-genova: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-carlo-felice-genova", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** The opera detail URLs, from the `lirica`-filtered WP REST `show` collection.
 *  One call returns every staged opera across all seasons (the index is small),
 *  so the window gates performances, not which shows are fetched. */
async function discoverOperaShows(ctx: FetchContext): Promise<string[]> {
  const shows = await fetchJson<ShowIndexEntry[]>(SHOWS_API, ctx);
  const urls = new Set<string>();
  for (const show of shows) {
    const url = show.link ?? (show.slug ? `${BASE}/spettacolo/${show.slug}/` : null);
    if (url) urls.add(url);
  }
  return [...urls];
}

async function buildProduction(
  detailUrl: string,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  const html = await fetchHtml(detailUrl, ctx);

  const title = cleanText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  if (!title) return null;

  const composer = parseComposer(html);
  if (!composer) return null;

  const performances = parsePerformances(html, since, today);
  if (performances.length === 0) return null;

  return {
    source_production_id: slugFromUrl(detailUrl),
    work_title: title,
    composer_name: composer,
    premiere_season: parseSeason(html),
    detail_url: detailUrl,
    image_url: parseImage(html),
    ...parseCredits(html),
    performances,
  };
}

/**
 * Composer, in source-reliability order:
 *   1. the `Musica di <strong>{X}</strong>` byline (current format; the `<mark>`
 *      colour wrapper the editor adds is stripped by `cleanText`);
 *   2. older pages have no such byline and name the composer in the FIRST content
 *      paragraph as "{form} in N atti di {X} su libretto di …" — we read that one
 *      paragraph (NOT the whole page, which carries librettist / source-author /
 *      coproduction "di …" clauses that would mis-fire) and take the "{form} … di
 *      {X}" clause, stopping before the libretto/source byline.
 * Returns null when no composer resolves → the billing is dropped (the opera gate).
 */
function parseComposer(html: string): string | null {
  const byline = cleanText(html.match(/Musica\s+di\s*<strong>([\s\S]*?)<\/strong>/i)?.[1] ?? "");
  if (byline && looksLikeComposer(byline)) return byline;

  // Only the first sentence of the first content paragraph carries the work
  // byline; the rest is the coproduction note (whose "Teatro Regio di Parma" would
  // otherwise be misread as a composer).
  const firstParagraph =
    cleanText(
      html.match(/<p class="[^"]*wp-block-paragraph[^"]*">([\s\S]*?)<\/p>/i)?.[1] ?? "",
    ).split(/\.\s/)[0] ?? "";
  const FORM =
    /melodramma|opera lirica|opera|dramma(?:\s+per\s+musica)?|tragedia(?:\s+lirica)?|farsa|commedia|favola|fiaba|azione|leggenda|scene?\s+liriche/;
  // Canonical "{form} … di {Composer} (su libretto di …)" — the composer follows
  // the form word. The intervening run must not cross a "libretto"/"su" byline,
  // else the `di` matched would be the librettist's (Anna Bolena's only `di` is
  // "su libretto di Felice Romani" — that must fall through to the reversed layout).
  const after = firstParagraph.match(
    new RegExp(`(?:${FORM.source})\\b(?:(?!\\b(?:libretto|su)\\b)[^.])*?\\bdi\\s+([^.]+)`, "i"),
  );
  if (after?.[1]) {
    const name = firstClause(after[1]);
    if (looksLikeComposer(name)) return name;
  }
  // Reversed layout ("Anna Bolena Gaetano Donizetti tragedia lirica …"): the
  // composer is the two-token name sitting immediately before the form word
  // (the title precedes it, so we anchor to the tokens nearest the form word).
  const before = firstParagraph.match(
    new RegExp(`([A-ZÀ-Ý][a-zà-ÿ.'’-]+\\s+[A-ZÀ-Ý][a-zà-ÿ.'’-]+)\\s+(?:${FORM.source})\\b`, "i"),
  );
  if (before?.[1] && looksLikeComposer(before[1])) return before[1].trim();

  return null;
}

/** Keep only the leading name clause, dropping any trailing libretto/source prose
 *  or co-author list that rides in the same text run ("Nino Rota, libretto …"). */
function firstClause(text: string): string {
  return (
    text
      .split(
        /\s*,\s*|\s+(?:su\b|libretto|dal\b|dalla\b|dall|da\b|testo|romanzo|dramma|commedia)\b/i,
      )[0]
      ?.trim() ?? text
  );
}

/** One-or-more capitalized name tokens (allowing "/" double bills, " & ", " e "),
 *  rejecting taglines that read as a sentence. */
function looksLikeComposer(text: string): boolean {
  const segments = text.split(/\s*[/&]\s*|\s+e\s+/).map((s) => s.trim());
  return (
    segments.length > 0 &&
    segments.every((seg) => /^[A-ZÀ-Ý][a-zà-ÿ.'’-]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ.'’-]+){0,3}$/.test(seg))
  );
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}

function parseImage(html: string): string | null {
  return html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1] ?? null;
}

/**
 * Performances from the `<table class="dkr-calendar-table">` rows: each row pairs
 * a `dkr-calendar-table-date` cell ("DO 19/04/2026", with an optional "(Prima)"
 * and a "Turno X" subscription tier in a nested `<p>`) with a
 * `dkr-calendar-table-time` cell ("Ore HH:MM") and a buy cell. The date is the
 * `DD/MM/YYYY` token; status comes from the buy cell — a vivaticket link / "Acquista"
 * is on sale, "non più disponibili" / "esaurit" is sold/closed, else scheduled.
 */
function parsePerformances(html: string, since: IsoDate | null, today: string): RawPerformance[] {
  const table =
    html.match(/<table class="dkr-calendar-table[^"]*">([\s\S]*?)<\/table>/i)?.[1] ?? "";
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, dateCell, timeCell, buyCell] of table.matchAll(
    /<td class="dkr-calendar-table-date">([\s\S]*?)<\/td>\s*<td class="dkr-calendar-table-time">([\s\S]*?)<\/td>\s*<td class="dkr-calendar-table-buy-tickets">([\s\S]*?)<\/td>/gi,
  )) {
    const dmy = (dateCell ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!dmy) continue;
    const date = `${dmy[3]}-${dmy[2]?.padStart(2, "0")}-${dmy[1]?.padStart(2, "0")}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (since && date < since) continue;

    const time = (timeCell ?? "").match(/(\d{1,2})[:.](\d{2})/);
    const hhmm = time ? `${time[1]?.padStart(2, "0")}:${time[2]}` : null;
    const room = cleanText((dateCell ?? "").match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "") || null;

    const key = `${date}|${hhmm}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date: date as IsoDate,
      time: hhmm,
      venue_room: room,
      ticket_url: (buyCell ?? "").match(/href="([^"]+)"/i)?.[1] ?? null,
      status: performanceStatus(buyCell ?? "", date, today),
    });
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

function performanceStatus(buyCell: string, date: string, today: string): RawPerformance["status"] {
  if (date < today) return "past";
  const text = stripHtml(buyCell).toLowerCase();
  if (/esaurit|sold\s*out/.test(text)) return "sold_out";
  if (/non più disponibili|non disponibili/.test(text)) return "scheduled";
  return "scheduled";
}

/**
 * Creative team + cast from the `<p>` credit rows. Each row is one or more
 * "label <strong>Name</strong>" lines split on `<br>`: a `<em>Role</em>` lead
 * marks a sung character (→ cast), an Italian function label marks a creative
 * credit, and everything else (Allestimento, ensemble lines) is dropped. Per-night
 * singer rotations ("(16, 18, 20)") and the Accademia "*" marker are stripped from
 * names; multiple `<strong>` runs in one row are all captured.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, body] of html.matchAll(
    /<p class="[^"]*wp-block-paragraph[^"]*">([\s\S]*?)<\/p>/gi,
  )) {
    if (!body) continue;
    for (const { label, role, names } of creditLines(body)) {
      if (role) {
        for (const singer of names) {
          const key = `${role}|${singer}`;
          if (seenCast.has(key)) continue;
          seenCast.add(key);
          cast.push({ role, name: singer });
        }
        continue;
      }
      const fn = label ? mapFunction(label) : null;
      if (!fn) continue;
      for (const person of names) {
        const key = `${fn}|${person}`;
        if (seenCreative.has(key)) continue;
        seenCreative.add(key);
        creative.push({ function: fn, name: person });
      }
    }
  }

  return { creative_team: creative, cast };
}

interface CreditLine {
  label: string | null;
  role: string | null;
  names: string[];
}

/**
 * Split a credit `<p>` body into label→value rows. The label (a plain-text
 * function like "Direttore" or an `<em>Role</em>`) and its `<strong>Name</strong>`
 * value(s) are separated by a `<br>`, and successive rows are separated by the
 * same `<br>` — so a `<br>`-split alone orphans every label from its name. We
 * instead split on `<br>` and carry a *pending* label forward: a line that is
 * label-only attaches to the `<strong>` values on the following line(s); a line
 * carrying both a label and a value pairs them directly. Lines with no value yet
 * no recognizable label (libretto/synopsis prose, ensemble credits) are skipped.
 */
function creditLines(body: string): CreditLine[] {
  const rows: CreditLine[] = [];
  let pendingLabel: string | null = null;
  let pendingRole: string | null = null;

  for (const line of body.split(/<br\s*\/?>/i)) {
    const names: string[] = [];
    for (const [, raw] of line.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)) {
      for (const name of splitNames(cleanName(raw ?? ""))) names.push(name);
    }

    const role = cleanText(line.match(/<em>([\s\S]*?)<\/em>/i)?.[1] ?? "") || null;
    const firstStrong = line.indexOf("<strong>");
    const before = firstStrong >= 0 ? line.slice(0, firstStrong) : line;
    const label = role ? null : cleanLabel(before.replace(/<\/?strong>/gi, ""));

    if (names.length === 0) {
      // A label-only line: remember it for the value rows that follow.
      if (role) {
        pendingRole = role;
        pendingLabel = null;
      } else if (label) {
        pendingLabel = label;
        pendingRole = null;
      }
      continue;
    }

    if (role) {
      rows.push({ label: null, role, names });
      pendingRole = role;
      pendingLabel = null;
    } else if (label) {
      rows.push({ label, role: null, names });
      pendingLabel = label;
      pendingRole = null;
    } else {
      // A bare value line (a per-night alternate) inherits the pending
      // label/role, which stays sticky for any further alternates.
      rows.push({ label: pendingLabel, role: pendingRole, names });
    }
  }
  return rows;
}

function cleanLabel(html: string): string {
  return cleanText(html)
    .replace(/[:.]\s*$/, "")
    .trim();
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A credit value may list several people; split on commas / " e ". Strip the
 *  Accademia "*" marker and per-night "(16, 18)" rotations, and drop ensemble
 *  names (orchestra, coro) — they aren't individual performers we model. */
function splitNames(value: string): string[] {
  return value
    .replace(/\([\d,\s]+\)/g, " ")
    .replace(/\*/g, " ")
    .split(/\s*,\s*|\s+e\s+|\s*\/\s*/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 2 &&
        !/orchestra|\bcoro\b|filarmonica|ensemble|tecnici|fondazione|compañia|accademia/i.test(s),
    );
}

/** Season from the `season` taxonomy class on the page (`season-2025-2026`), the
 *  og:title "… Stagione 2025/2026 …" suffix, or the calendar's latest year. */
function parseSeason(html: string): string | null {
  const cls = html.match(/season-(\d{4})-(\d{2,4})\b/i);
  if (cls) return `${cls[1]}/${cls[2]}`;
  const og = html.match(/Stagione\s+(\d{4})\/(\d{2,4})/i);
  if (og) return `${og[1]}/${og[2]}`;
  return null;
}

/** Typographic / accented entities the shared `decodeEntities` map omits but that
 *  show up in Italian role and singer names. */
const EXTRA_ENTITIES: Record<string, string> = {
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&scaron;": "š",
  "&Scaron;": "Š",
  "&zcaron;": "ž",
  "&Zcaron;": "Ž",
  "&ccaron;": "č",
  "&Ccaron;": "Č",
};

function cleanName(html: string): string {
  return cleanText(html);
}

function cleanText(html: string): string {
  const pre = html
    .replace(/<mark[^>]*>/gi, "")
    .replace(/<\/mark>/gi, "")
    .replace(/&[A-Za-z]+;/g, (m) => EXTRA_ENTITIES[m] ?? m);
  return decodeEntities(stripHtml(pre)).replace(/\s+/g, " ").trim();
}
