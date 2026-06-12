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
 * Teatro Massimo, Palermo (`json-api` strategy) — Italy's largest opera house by
 * volume (a fondazione lirica). Opera, balletto and concerti share one season.
 *
 * The house's `/calendario/` page embeds the entire dated programme as an inline
 * `var events = [ … ]` JS array — one object per performed night, 2017→future, in
 * a single fetch — carrying `permalink` (the `/event/{slug}/` detail URL),
 * `category_slug` (the house's own taxonomy: "opere" / "balletti" / "concerti" /
 * "educational" / …), the local-time `year`/`month`/`day` + `time`, and `place`
 * (the room, e.g. "Sala Grande"). We read that array, keep only `category_slug ===
 * "opere"`, and group its rows by `permalink` into productions — so the calendar
 * IS both the opera filter and the dated-performance source, no fragile date prose
 * needed (the detail pages only print a prose date range, never structured nights).
 *
 * Each production's detail page is then fetched once for the production-level
 * facts. The Italian `/event/{slug}/` page carries everything inline in an
 * `event__artists-info__text` block (no usable JSON-LD — Yoast boilerplate only,
 * no API — the WP REST `event` endpoint 401s):
 *   - composer as a "Musiche di / Musica di {Composer}" byline, or a bare leading
 *     name line on the older `<div>`-wrapped layout — REQUIRED (the opera gate);
 *   - creative team + cast as `label <strong>Name</strong>` lines (split on `<br>`
 *     and the per-credit `<div>`/`<p>` wrappers) whose ITALIAN labels (Direttore,
 *     Regia, Scene, Costumi, Luci, …) map to canonical functions in CREATIVE_LABELS;
 *   - cast lines follow an `<h3>Cast / Personaggi e interpreti</h3>` heading; each
 *     `role <strong>Singer</strong> (day, day)` row may alternate singers with " / "
 *     and trail per-night day hints, which are stripped.
 *
 * The category array thins out before 2017; deeper history comes from Wikidata
 * (Q261439, 8 works) in backfill mode.
 */

const BASE = "https://www.teatromassimo.it";
const CALENDAR_URL = `${BASE}/calendario/`;
/** Teatro Massimo Vittorio Emanuele on Wikidata — verified via wbsearchentities
 *  (it) → EntityData Q261439: P31 = opera house (Q153562) + theatre building
 *  (Q24354), P17 = Italy (Q38), P856 = teatromassimo.it; 8 works link via P4647
 *  (premiere here) / P272 (produced here). Distinct from Teatro Massimo Bellini
 *  Catania (Q1429352) and the Cagliari/Pescara theatres of the same name. */
const WIKIDATA_QID = "Q261439";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/**
 * Italian creative-function labels → canonical function keys, tested in order.
 * English equivalents from the `/en/` mirror are folded in so the map survives a
 * site-language flip. "Regia" is matched before the set/costume rules because the
 * site combines it ("Regia, scene e costumi"); chorus-master precedes the generic
 * conductor rule. Unmapped labels (assistants, "azioni mimiche", "regista
 * collaboratrice", "riprese") are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro|chorus master/i, "chorus-master"],
  [/direttor|direttric|direzione musicale|maestro concertatore|conductor/i, "conductor"],
  [/regia|staging|^director\b/i, "director"],
  [/coreograf|choreograph/i, "choreographer"],
  [/disegno luci|^luci\b|^luce\b|lighting|lights/i, "lighting"],
  [/scene e costumi|scene and costume/i, "set-designer"],
  [/^costumi|costume/i, "costume-designer"],
  [/scenografia|^scene\b|^sets?\b|set design/i, "set-designer"],
  [/drammaturgia|dramaturgy/i, "dramaturgy"],
];

interface CalendarEvent {
  permalink?: string | null;
  title?: string | null;
  category_slug?: string | null;
  place?: string | null;
  day?: number | null;
  month?: number | null;
  year?: number | null;
  time?: string | null;
}

export async function scrapeTeatroMassimoPalermo(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);
    const byPermalink = groupOperaPerformances(await fetchCalendarEvents(ctx), since, today);

    for (const [detailUrl, performances] of byPermalink) {
      try {
        const prod = await buildProduction(detailUrl, performances, ctx);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-massimo-palermo: ${detailUrl} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-massimo-palermo: calendar scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-massimo-palermo: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-massimo-palermo", productions };
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** Read the inline `var events = [ … ];` array the calendar page hydrates from. */
async function fetchCalendarEvents(ctx: FetchContext): Promise<CalendarEvent[]> {
  const html = await fetchHtml(CALENDAR_URL, ctx);
  const m = html.match(/\bevents\s*=\s*(\[[\s\S]*?\]);/);
  if (!m?.[1]) return [];
  return JSON.parse(m[1]) as CalendarEvent[];
}

/**
 * Keep only the "opere" rows, build each into a `RawPerformance` from its
 * local-time `year`/`month`/`day` + `time` fields, and group by detail URL — the
 * same production runs across several nights. `place` is the room (Sala Grande /
 * Sala ONU). Non-staged "Opere"-tagged season-overview pages survive here but are
 * dropped later by the composer gate.
 */
function groupOperaPerformances(
  events: CalendarEvent[],
  since: IsoDate | null,
  today: string,
): Map<string, RawPerformance[]> {
  const byPermalink = new Map<string, RawPerformance[]>();

  for (const e of events) {
    if (e.category_slug !== "opere") continue;
    const detailUrl = e.permalink?.trim();
    if (!detailUrl || !e.year || !e.month || !e.day) continue;

    const date = `${e.year}-${pad2(e.month)}-${pad2(e.day)}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (since && date < since) continue;

    const time = e.time?.match(/^(\d{1,2}):(\d{2})/);
    const list = byPermalink.get(detailUrl) ?? [];
    list.push({
      date: date as IsoDate,
      time: time ? `${time[1]?.padStart(2, "0")}:${time[2]}` : null,
      venue_room: e.place ? stripHtml(e.place).trim() || null : null,
      status: date < today ? "past" : "scheduled",
    });
    byPermalink.set(detailUrl, list);
  }

  for (const list of byPermalink.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  }
  return byPermalink;
}

async function buildProduction(
  detailUrl: string,
  performances: RawPerformance[],
  ctx: FetchContext,
): Promise<RawProduction | null> {
  if (performances.length === 0) return null;
  const html = await fetchHtml(detailUrl, ctx);

  const body = artistsBlock(html);
  const composer = parseComposer(body);
  if (!composer) return null;

  // The page `<h1>` (the event__title heading) is the work title across every
  // layout; the in-block `<h3>` is a fallback for the few pages that omit it.
  const title = cleanText(
    html.match(/event__title[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
      body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ??
      "",
  );
  if (!title) return null;

  return {
    source_production_id: slugFromUrl(detailUrl),
    work_title: title,
    composer_name: composer,
    premiere_season: parseSeason(html) ?? seasonOf(performances[0]?.date),
    detail_url: detailUrl,
    image_url: parseImage(html),
    ...parseCredits(body),
    performances,
  };
}

/** The `event__artists-info__text` block holds the title, composer byline, creative
 *  team and cast; everything we parse lives inside it, scripts stripped. */
function artistsBlock(html: string): string {
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const m = noScript.match(/event__artists-info__text[^>]*>([\s\S]*?)<\/section>/i);
  return m?.[1] ?? noScript;
}

/**
 * Composer (the opera gate) is bylined in several layouts across the archive,
 * tried in order of specificity:
 *   1. an explicit "Musica/Musiche di … / Music by … <strong>Name</strong>" label;
 *   2. a genre line ending in "di" ("Tragedia lirica in due atti di",
 *      "<em>di</em>", "Azione in tre atti di") followed by "<strong>Name</strong>";
 *   3. a bare name line — `<strong>Georges Bizet</strong>` or plain `Giuseppe
 *      Verdi` in its own `<p>`/`<div>` — sitting before the work's title heading.
 * Returns null when none resolves to a person name → the billing is dropped
 * (season-launch / streaming / dress-rehearsal "Opere" pages carry no composer).
 */
function parseComposer(body: string): string | null {
  const musica = body.match(
    /<(?:em|i)>[^<]*\b(?:music[ae] di|musiche di|music by)\s*<\/(?:em|i)>\s*<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/i,
  );
  if (musica?.[1]) {
    const name = cleanText(musica[1]);
    if (looksLikeComposer(name)) return name;
  }

  // A genre/form line whose italic run ends in "di" introduces the composer.
  const diByline = body.match(
    /<(?:em|i)>[^<]*\bdi\s*<\/(?:em|i)>\s*<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/i,
  );
  if (diByline?.[1]) {
    const name = cleanText(diByline[1]);
    if (looksLikeComposer(name)) return name;
  }

  // Bare name line before the title heading: walk the `<p>`/`<div>` blocks that
  // precede the first `<h3>` (the work title in this layout); the first whose text
  // is a person name is the composer. Stop at the title so creative names below
  // aren't mistaken for it.
  const beforeTitle = body.split(/<h3[^>]*>/i)[0] ?? body;
  for (const [, inner] of beforeTitle.matchAll(/<(?:p|div)>([\s\S]*?)<\/(?:p|div)>/g)) {
    const name = cleanText(inner ?? "");
    if (name && looksLikeComposer(name)) return name;
  }
  return null;
}

/** One-or-more capitalized name tokens (allowing "/" double bills, " e "),
 *  rejecting taglines / form lines that read as a sentence. */
function looksLikeComposer(text: string): boolean {
  const segments = text.split(/\s*\/\s*|\s+e\s+/).map((s) => s.trim());
  return (
    segments.length > 0 &&
    segments.every((seg) => /^[A-ZÀ-Ý][a-zà-ÿ.'’-]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ.'’-]+){0,3}$/.test(seg))
  );
}

/**
 * Creative team + cast both read as `label <strong>Name</strong>` lines. The
 * markup mixes layouts: the current pages list credits in one `<p>` with `<br>`
 * separators, the older pages wrap each credit in its own `<div>`; the cast block
 * follows an `<h3>Cast | Personaggi e interpreti</h3>` heading. We split the block
 * at that heading, parse both halves into label/name lines, and let the label
 * decide — a label mapping to a creative function is a credit, a remaining label is
 * a sung role → cast. The per-night day hints in cast cells ("(11, 13, 15)") are
 * stripped and singer alternates split on " / ".
 */
function parseCredits(body: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const split = body.split(/<h3[^>]*>\s*(?:cast|personaggi[^<]*)<\/h3>/i);
  const creativeHtml = split[0] ?? body;
  const castHtml = split.slice(1).join(" ");

  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const { label, name } of labelStrongLines(creativeHtml)) {
    if (isStaffNoise(label)) continue;
    const fn = mapFunction(label);
    if (!fn) continue;
    for (const person of splitNames(name)) {
      const key = `${fn}|${person}`;
      if (seenCreative.has(key)) continue;
      seenCreative.add(key);
      creative_team.push({ function: fn, name: person });
    }
  }

  for (const { label, name } of castLines(castHtml)) {
    if (mapFunction(label) || isStaffNoise(label) || !looksLikeRole(label)) continue;
    for (const singer of splitCastSingers(name)) {
      const key = `${label}|${singer}`;
      if (seenCast.has(key)) continue;
      seenCast.add(key);
      cast.push({ role: label, name: singer });
    }
  }

  return { creative_team, cast };
}

/**
 * Parse the block into `{ label, name }` credit rows. Both layouts (the current
 * `<p>`-with-`<br>` list and the older per-credit `<div>` wrapping) print every
 * credit as an italic label tag (`<em>` / `<i>`) immediately followed by the bold
 * name run (`<strong>` / `<b>`): "<em>Regia</em> <strong>Bárbara Lluch</strong>".
 * Matching that pair globally is robust against the irregular `<br>`, `<div>` and
 * `<span>` noise around them — and naturally separates two labeled credits packed
 * into one bold run ("Ariemme <i>Luci</i> Ledda" → costumes + lighting), while a
 * bare unlabeled sub-credit run (no italic label) simply yields no pair and is
 * dropped. The name run may itself wrap an inner italic sub-label (Rigoletto's
 * "Turturro <i>ripresa da</i> Capaccioli"); we strip inner tags and let splitNames
 * trim the trailing sub-credit.
 */
function labelStrongLines(html: string): { label: string; name: string }[] {
  const clean = html.replace(/<\/?span[^>]*>/gi, "");
  const rows: { label: string; name: string }[] = [];
  for (const [, rawLabel, rawName] of clean.matchAll(
    /<(?:em|i)>([\s\S]*?)<\/(?:em|i)>\s*<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi,
  )) {
    const label = cleanLabel(rawLabel ?? "");
    // A second labeled credit is sometimes packed inside the bold name run with the
    // label italicised and its value bare ("Ariemme <i>Luci</i> Ledda"): split the
    // run at that inner label so the trailing credit doesn't pollute this name.
    const inner = (rawName ?? "").match(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>([\s\S]*)/i);
    const name = cleanText((inner ? (rawName ?? "").slice(0, inner.index) : rawName) ?? "");
    if (label && name) rows.push({ label, name });
    if (inner) {
      const innerLabel = cleanLabel(inner[1] ?? "");
      const innerName = cleanText(inner[2] ?? "");
      if (innerLabel && innerName) rows.push({ label: innerLabel, name: innerName });
    }
  }
  return rows;
}

/**
 * Cast rows read as `Role <strong>Singer (days) / Singer (days)</strong>`, but the
 * role label is inconsistently tagged — italicised on most rows yet bare text on
 * the first one ("Santuzza <strong>…</strong>"). So unlike the creative team we
 * can't key off the italic label; instead we split the block into `<br>`-delimited
 * lines (hoisting any trailing `<br>` out of the bold run first), and take the bold
 * run as the singer(s) and the plain text before it as the role. The per-night day
 * hints and singer alternates inside the run are left for splitCastSingers.
 */
function castLines(html: string): { label: string; name: string }[] {
  const normalized = html
    .replace(/<\/?(?:em|i)>/gi, "")
    .replace(/<\/?span[^>]*>/gi, "")
    .replace(/<br\s*\/?>(\s*)<\/(strong|b)>/gi, "</$2>$1<br/>")
    .replace(/<\/(?:div|p)>|<(?:div|p)[^>]*>/gi, "<br/>");
  const rows: { label: string; name: string }[] = [];
  for (const line of normalized.split(/<br\s*\/?>/i)) {
    const strong = line.match(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/i);
    if (!strong) continue;
    const name = cleanText(strong[1] ?? "");
    const label = cleanLabel(line.slice(0, line.indexOf(strong[0])));
    if (label && name) rows.push({ label, name });
  }
  return rows;
}

/**
 * Auxiliary-staff labels that carry a credit-function keyword (so they'd map) or a
 * role-shaped name (so they'd look like cast) but aren't a principal credit: the
 * assistants, collaborators, revival supervisors, consultants, mime hands and the
 * "E con la partecipazione di" supernumerary line. Dropped from BOTH halves so an
 * "Assistente alla regia" isn't filed as a second director nor as a sung role.
 */
const STAFF_NOISE =
  /assistente|collaborat|riprese|ripresa|consulen|orchestrazioni|azioni mimiche|movimenti|aiuto|sopratitoli|allest|durata|libretto|melodramma|coordinator|directing|partecipazione|riprese da/i;

function isStaffNoise(label: string): boolean {
  return STAFF_NOISE.test(label);
}

/** A role label is a short character name, not a synopsis fragment or staff label. */
function looksLikeRole(label: string): boolean {
  if (label.length > 40 || label.split(/\s+/).length > 5) return false;
  if (/^(il|lo|la|i|gli|le|un|uno|una|l)$/i.test(label)) return false;
  return true;
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A nested sub-credit sometimes rides inside a credit's bold run ("John Turturro
 *  ripresa da Lisa Capaccioli Coordinatrice …"); cut the value at the first such
 *  connector so only the principal name(s) survive. */
const SUBCREDIT_CONNECTOR =
  /\s+(?:ripresa? da|ripres[oa]|restaged by|coordinat\w*|assistente|collaborat\w*|aiuto)\b/i;

/** A creative-credit value may list several people; trim any nested sub-credit,
 *  then split on commas / " e ". Drop ensemble names (orchestra, coro) — they
 *  aren't individual performers we model. */
function splitNames(value: string): string[] {
  return (value.split(SUBCREDIT_CONNECTOR)[0] ?? value)
    .split(/\s*,\s*|\s+e\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s));
}

/** A cast value lists one or more singers, each optionally trailed by its
 *  performance days in parens ("Berzhanskaya (11, 13, 15)"); alternates split on
 *  " / ". Strip the day hints and keep the names. */
function splitCastSingers(cell: string): string[] {
  return cell
    .split(/\s*\/\s*/)
    .map((s) => s.replace(/\s*\([^)]*\)\s*$/, "").trim())
    .filter((s) => s.length >= 2 && !/orchestra|\bcoro\b|filarmonica|ensemble/i.test(s));
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}

function parseImage(html: string): string | null {
  return html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1] ?? null;
}

/** The season is printed in the `event__meta` ribbon ("Stagione 2025-26 / Opere"
 *  → "2025/26"); fall back to null when the page omits it. */
function parseSeason(html: string): string | null {
  const meta = cleanText(html.match(/event__meta[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");
  const m = meta.match(/(\d{4})\s*[-/]\s*(\d{2,4})/);
  if (!m) return null;
  const end = m[2]?.length === 4 ? m[2].slice(2) : m[2];
  return `${m[1]}/${end}`;
}

/** Typographic / accented entities the shared `decodeEntities` map omits but that
 *  show up in Italian role and singer names (l'elisir, Dvořák). */
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

function cleanText(html: string): string {
  const pre = html.replace(/&[A-Za-z]+;/g, (m) => EXTRA_ENTITIES[m] ?? m);
  return decodeEntities(stripHtml(pre)).replace(/\s+/g, " ").trim();
}

function cleanLabel(html: string): string {
  return cleanText(html)
    .replace(/[:.]\s*$/, "")
    .trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Italian opera seasons run autumn→summer; a Jan 2026 night belongs to "2025/26".
 *  Used when the `event__meta` season ribbon is absent (it's empty on the IT pages). */
function seasonOf(date: IsoDate | undefined): string | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (!year || !month) return null;
  const start = month >= 8 ? year : year - 1;
  return `${start}/${pad2((start + 1) % 100)}`;
}
