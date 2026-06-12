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
 * Fondazione Teatro Donizetti, Bergamo (`json-api` strategy) — a teatro di
 * tradizione whose year-round seasons (stagione lirica, prosa, operetta, jazz)
 * share a calendar with the autumn Donizetti Opera festival; the current
 * festival edition's staged operas surface on this site too (past editions live
 * only on the sister festival domain as thin archive stubs, so they come from
 * Wikidata).
 *
 * Both the season and the festival run on the same Avada/WordPress stack whose
 * category listing pages render their event cards client-side. The cards are fed
 * by a custom calendar plugin at `ecal.teatrodonizetti.it/api/calendar_feed`
 * (POST) that returns every event (181 across the whole programme) fully
 * structured in one call — `slug`, `title`, the primary `data_std` date, `ora`
 * time, the `altreDate[]` list of all other performance dates as Italian
 * "DD mese YYYY" strings, the `luogo` venue (Teatro Donizetti / Teatro Sociale /
 * Casa Natale), and a `categorie[]` taxonomy. That feed is the discovery +
 * dates + venue + category layer; it carries no composer or cast.
 *
 * We keep only events whose category is one of the opera/festival terms
 * (OPERA_CATEGORY_SLUGS) — that already drops prosa, operetta, jazz, cinema,
 * Opera Family workshops, Opera Stories talks etc. — then fetch each survivor's
 * `/it/evento/{slug}/` detail page for the production facts. The detail page is
 * the real opera gate: it must carry a `musica di {Composer}` byline AND a genre
 * line that is opera (not "balletto"/"concerto"/"danza"/"recital") AND a sung
 * cast of named roles. That filter is what drops the concerti billed under
 * "Opera & Concerti" (Messiah, Concerto di Natale, …) and the danced Carmen
 * ("balletto … su musica di Bizet") that share the opera categories.
 *
 * Credits/cast on the detail page are `label <strong>Name</strong>` lines split
 * on `<br>`, in two markup variants: an `<em>label</em> <strong>Name</strong>`
 * locandina (Turandot) and a `<p class="MsoNormal">Label <strong>Name</strong>`
 * cast block (Alahor). Both are parsed; the ITALIAN labels (direttore/direttrice,
 * regia, scene, costumi, luci, maestro del coro, coreografia, drammaturgia) map
 * to canonical functions in CREATIVE_LABELS — composerFromText is German-only and
 * is NOT used. Performances are built from the feed's dates (not the detail HTML),
 * honoring `window.since`; backfill appends Wikidata (Q3516755) for past editions.
 */

const BASE = "https://www.teatrodonizetti.it";
/** The current festival edition's opera detail pages carry their content on the
 *  sister festival domain, the season's on the main site; we try both per slug
 *  and keep whichever serves the opera byline. */
const FESTIVAL_BASE = "https://www.donizettiopera.org";
const FEED_URL = "https://ecal.teatrodonizetti.it/api/calendar_feed";
/**
 * Teatro Donizetti, Bergamo on Wikidata — verified via wbsearchentities (it):
 * Q3516755, "theatre and opera house in Bergamo, Italy" (P31 = opera house
 * Q153562; P17 = Italy Q38). 17 works link to it via P4647 (premiere here) /
 * P272 (produced here); the sibling theatre *company* Q113482159 carries 0, so
 * Q3516755 is the production-bearing entity.
 */
const WIKIDATA_QID = "Q3516755";

/** Daily incremental run re-fetches this rolling past window for late corrections. */
const RECENT_PAST_DAYS = 45;

/**
 * Calendar categories that can carry staged opera: the festival's "Opera {year}"
 * terms and the season's "Opera & Concerti" strand. The latter mixes in concerti
 * — those are dropped on the detail page (no opera genre line / no sung cast), not
 * here. Every other term (prosa, operetta, jazz, cinedopera, opera-family, …) is
 * excluded outright.
 */
const OPERA_CATEGORY_SLUGS = /^(opera-\d{4}|il-festival-donizetti-opera|opera-concerti)$/i;

/**
 * Italian creative-function labels → canonical function keys, tested in order.
 * "Regia" is matched before the set/costume rules because the site combines it
 * ("regia, scene e costumi"); chorus-master precedes the generic conductor rule
 * so "maestro del coro" isn't swallowed by "maestro". "Direttrice" is the
 * feminine of "direttore". Unmapped labels (libretto, allestimento, voci bianche,
 * assistente, …) are dropped.
 */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/maestro del coro|chorus master/i, "chorus-master"],
  [/direttore|direttrice|direzione musicale|maestro concertatore|conductor/i, "conductor"],
  [/regia|staging|director/i, "director"],
  [/coreograf|choreograph/i, "choreographer"],
  [/disegno luci|light designer|^luci\b|^luce\b|lights|lighting/i, "lighting"],
  [/scene e costumi/i, "set-designer"],
  [/^costumi|costumes/i, "costume-designer"],
  [/scenografia|^scene\b|^sets?\b|set design/i, "set-designer"],
  [/drammaturgia|dramaturgy/i, "dramaturgy"],
];

/** Genre words that mark a non-staged-opera billing on the detail page; their
 *  presence in the work's genre line drops the event (a danced Carmen, a concert,
 *  a recital), even though it sits under an opera calendar category. */
const NON_OPERA_GENRE = /\b(balletto|danza|concerto|concerti|recital|gala|cinema|prosa)\b/i;

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

interface FeedCategory {
  slug?: string | null;
  label?: string | null;
}

interface FeedEvent {
  id?: number;
  title?: string | null;
  slug?: string | null;
  data_std?: string | null;
  ora?: string | null;
  altreDate?: string[] | false | null;
  luogo?: { label?: string | null; slug?: string | null } | null;
  categorie?: FeedCategory[] | null;
}

export async function scrapeTeatroDonizettiBergamo(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const events = (await fetchFeed(ctx)).filter(isOperaCategory);
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);

    for (const event of events) {
      try {
        const prod = await buildProduction(event, ctx, since, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`teatro-donizetti-bergamo: ${event.slug ?? event.id} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("teatro-donizetti-bergamo: calendar feed scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("teatro-donizetti-bergamo: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "teatro-donizetti-bergamo", productions };
}

/** POST the calendar feed for a wide window; it returns every programme event in
 *  one structured array regardless of date, so the window only gates emitted
 *  performances, not the fetch. */
async function fetchFeed(ctx: FetchContext): Promise<FeedEvent[]> {
  const body =
    "start=2018-01-01T00:00:00Z&end=2030-01-01T00:00:00Z&lang=it" +
    "&categorie=&calendari=&in_evidenza=&luogo=&organizzatore=&view=listMonthCustom";
  const res = await fetchJson<FeedEvent[]>(
    `${FEED_URL}?_=${encodeURIComponent(body)}`,
    ctx,
    "application/json",
  ).catch(() => null);
  if (res && Array.isArray(res)) return res;
  // The plugin reads its filters from the POST body; the query-string variant
  // above is a no-cost first try for proxies that strip bodies. Fall back to POST.
  return postFeed(body, ctx);
}

async function postFeed(body: string, ctx: FetchContext): Promise<FeedEvent[]> {
  const proxyUrl = process.env.FETCH_PROXY_URL;
  const headers: Record<string, string> = {
    "User-Agent": ctx.userAgent,
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  let target = FEED_URL;
  if (ctx.proxy) {
    target = `${ctx.proxy.url}?url=${encodeURIComponent(FEED_URL)}`;
    if (ctx.proxy.token) headers.Authorization = `Bearer ${ctx.proxy.token}`;
  } else if (proxyUrl) {
    target = `${proxyUrl}?url=${encodeURIComponent(FEED_URL)}`;
    if (process.env.FETCH_PROXY_TOKEN)
      headers.Authorization = `Bearer ${process.env.FETCH_PROXY_TOKEN}`;
  }
  const res = await fetch(target, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`calendar feed POST → ${res.status}`);
  const data = (await res.json()) as FeedEvent[];
  return Array.isArray(data) ? data : [];
}

function isOperaCategory(event: FeedEvent): boolean {
  return (event.categorie ?? []).some((c) => OPERA_CATEGORY_SLUGS.test(c.slug ?? ""));
}

/** The lower bound on performance dates: incremental keeps the future plus a
 *  rolling recent-past refresh; backfill honors `window.since` (unbounded if null). */
function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

async function buildProduction(
  event: FeedEvent,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  const slug = event.slug;
  if (!slug) return null;

  const performances = parsePerformances(event, since, today);
  if (performances.length === 0) return null;

  const detail = await fetchDetail(slug, ctx);
  if (!detail) return null;
  const { detailUrl, html, body } = detail;

  // A danced or concert billing under an opera category carries a non-opera genre
  // line ("balletto in due atti …") — drop it before trusting the composer byline.
  if (NON_OPERA_GENRE.test(parseGenreLine(body))) return null;

  const composer = parseComposer(body);
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(body);

  const title = parseTitle(body, event.title ?? "");
  if (!title) return null;

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: detailUrl,
    image_url: parseImage(html),
    creative_team,
    cast,
    performances,
  };
}

/**
 * Fetch the production detail page, trying the season site first then the
 * festival domain. The opera content lives on exactly one of them per slug
 * (season operas on teatrodonizetti.it, festival operas on donizettiopera.org);
 * the other serves a content-less stub. We keep the first response that carries a
 * "musica di" byline, falling back to the last fetched body so the non-opera gate
 * still runs on a stub.
 */
async function fetchDetail(
  slug: string,
  ctx: FetchContext,
): Promise<{ detailUrl: string; html: string; body: string } | null> {
  let last: { detailUrl: string; html: string; body: string } | null = null;
  for (const base of [BASE, FESTIVAL_BASE]) {
    const detailUrl = `${base}/it/evento/${slug}/`;
    try {
      const html = await fetchHtml(detailUrl, ctx);
      const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
      last = { detailUrl, html, body };
      if (/musica di/i.test(body)) return last;
    } catch {
      // try the other domain
    }
  }
  return last;
}

/** Performances come from the feed: every date in `altreDate[]` (Italian
 *  "DD mese YYYY"), or the single `data_std` when there are no extra dates. The
 *  `ora` time applies to all; the venue is the feed's `luogo`. */
function parsePerformances(
  event: FeedEvent,
  since: IsoDate | null,
  today: string,
): RawPerformance[] {
  const venue = event.luogo?.label ? stripHtml(event.luogo.label).trim() || null : null;
  const time = normalizeTime(event.ora ?? null);

  const dates = new Set<string>();
  if (Array.isArray(event.altreDate)) {
    for (const raw of event.altreDate) {
      const iso = parseItalianDate(raw);
      if (iso) dates.add(iso);
    }
  }
  if (dates.size === 0 && event.data_std && /^\d{4}-\d{2}-\d{2}$/.test(event.data_std)) {
    dates.add(event.data_std);
  }

  const out: RawPerformance[] = [];
  for (const date of dates) {
    if (since && date < since) continue;
    out.push({
      date: date as IsoDate,
      time,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** "14 novembre 2026" → "2026-11-14"; null when the month word isn't recognized. */
function parseItalianDate(raw: string): string | null {
  const m = raw
    .trim()
    .toLowerCase()
    .match(/(\d{1,2})\s+([a-zà-ÿ]+)\s+(\d{4})/);
  if (!m) return null;
  const day = m[1]?.padStart(2, "0");
  const month = MONTHS[m[2] ?? ""];
  const year = m[3];
  return month && day && year ? `${year}-${month}-${day}` : null;
}

function normalizeTime(raw: string | null): string | null {
  const m = raw?.match(/(\d{1,2})[:.](\d{2})/);
  return m ? `${m[1]?.padStart(2, "0")}:${m[2]}` : null;
}

/** The work title from the detail-page `<h1>` (composer + title in <strong> runs)
 *  when present, else the feed title. The h1 often stacks the composer over the
 *  uppercased work title; take the longest <strong> run that isn't the composer. */
function parseTitle(body: string, feedTitle: string): string {
  const h1 = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";
  const runs = [...h1.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)]
    .map((m) => cleanText(m[1] ?? ""))
    .filter(Boolean);
  // The title heading is the last/uppercased run; fall back to the feed title.
  const fromH1 = runs.length ? runs[runs.length - 1] : "";
  return titleCase(fromH1 || cleanText(feedTitle));
}

/** Site titles are ALL-CAPS; restore readable casing while leaving an already
 *  mixed-case string (the locandina h1) untouched. */
function titleCase(text: string): string {
  if (!text || text !== text.toUpperCase()) return text;
  return text
    .toLowerCase()
    .replace(/(^|[\s'’(.-])([a-zà-ÿ])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** The genre line is the first emphasised descriptor on the detail page
 *  ("opera in tre atti", "balletto in due atti", "melodramma …") — used to reject
 *  non-opera billings. */
function parseGenreLine(body: string): string {
  for (const [, inner] of body.matchAll(/<em>([\s\S]*?)<\/em>/gi)) {
    const text = cleanText(inner ?? "");
    if (/\b(opera|melodramma|dramma|balletto|danza|concerto|concerti|recital|farsa)\b/i.test(text))
      return text;
  }
  return "";
}

/** Composer = the "musica di {Name}" byline; the name is the immediately
 *  following `<strong>` run. Returns null when no byline is present → the event is
 *  dropped (the opera gate). */
function parseComposer(body: string): string | null {
  // The name may span adjacent <strong> runs ("<strong>Gaetano</strong>
  // <strong>Donizetti</strong>"); merge them, then take the first run after the
  // "musica di" byline.
  const merged = body.replace(/<\/strong>(\s|&nbsp;)*<strong>/gi, " ");
  const m = merged.match(/musica di\s*(?:<\/em>)?\s*(?:&nbsp;|\s)*<strong>([\s\S]*?)<\/strong>/i);
  const name = cleanText((m?.[1] ?? "").replace(/<br\s*\/?>/gi, " "));
  return name && looksLikeName(name) ? name : null;
}

/** One-to-four capitalized name tokens (a person), rejecting genre/byline prose. */
function looksLikeName(text: string): boolean {
  return /^[A-ZÀ-Ý][a-zà-ÿ.'’-]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ.'’-]+){0,3}$/.test(text);
}

function parseImage(html: string): string | null {
  return html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1] ?? null;
}

/**
 * Credits and cast both live as `label <strong>Name</strong>` lines split on
 * `<br>`. Two markup variants: an `<em>label</em> <strong>Name</strong>`
 * locandina and a `<p class="MsoNormal">Label <strong>Name</strong>` block. We
 * normalize `<em>` to plain text, split on `<br>`, and let the label decide: a
 * line whose Italian label maps to a creative function is a creative credit;
 * a short non-staff label preceding a bold name is a sung role → cast. Names
 * split across multiple adjacent `<strong>` runs ("<strong>Laura</strong>
 * <strong>Verrecchia</strong>") are joined.
 */
function parseCredits(body: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const { label, name } of labelStrongLines(body)) {
    const fn = mapFunction(label);
    if (fn) {
      for (const person of splitNames(name)) {
        const key = `${fn}|${person}`;
        if (seenCreative.has(key)) continue;
        seenCreative.add(key);
        creative.push({ function: fn, name: person });
      }
    } else if (looksLikeRole(label)) {
      for (const singer of splitNames(name)) {
        const key = `${label}|${singer}`;
        if (seenCast.has(key)) continue;
        seenCast.add(key);
        cast.push({ role: label, name: singer });
      }
    }
  }
  return { creative_team: creative, cast };
}

/** Parse `label <strong>Name</strong>[ <strong>Name2</strong>]` lines. We merge
 *  adjacent bold runs into one name, take the plain text before the first bold run
 *  as the label, and drop ensemble lines (Orchestra/Coro …) that have no label. */
function labelStrongLines(body: string): { label: string; name: string }[] {
  const normalized = body
    .replace(/<\/?em>/gi, " ")
    // A stray <br> sometimes sits *inside* the bold run ("<strong>Name<br></strong>");
    // hoist it out so the split-on-<br> below keeps the name whole.
    .replace(/<br\s*\/?>(\s*)<\/strong>/gi, "</strong>$1<br/>")
    .replace(/<\/strong>(\s|&nbsp;)*<strong>/gi, " ")
    .replace(/<\/p>|<p[^>]*>/gi, "<br/>");
  const rows: { label: string; name: string }[] = [];
  for (const line of normalized.split(/<br\s*\/?>/i)) {
    const strong = line.match(/<strong>([\s\S]*?)<\/strong>/i);
    if (!strong) continue;
    const name = cleanText(strong[1] ?? "");
    const label = cleanLabel(line.slice(0, line.indexOf(strong[0])));
    if (label && name) rows.push({ label, name });
  }
  return rows;
}

function cleanLabel(html: string): string {
  return cleanText(html)
    .replace(/[:.\-–—]\s*$/, "")
    .trim();
}

/** Production-staff labels with no canonical credit function — librettist,
 *  assistants, revival hands, ensemble descriptors. Not sung roles, so dropped. */
const NON_ROLE_LABELS =
  /musica di|libretto|allestimento|assistente|maestr|drammaturg|video|aiuto|collabora|sopratitoli|edizione|riprese|prima rappresentazione|durata|coro|orchestra|voci bianche|melo-?dramma|opera in|balletto|atto/i;

/** A role label is a short character name, not a synopsis fragment or staff term. */
function looksLikeRole(label: string): boolean {
  if (label.length > 40 || label.split(/\s+/).length > 5) return false;
  if (NON_ROLE_LABELS.test(label)) return false;
  if (/^(il|lo|la|i|gli|le|un|uno|una|l|e)$/i.test(label)) return false;
  return true;
}

function mapFunction(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

/** A credit value may list several people; split on commas / " e ". Drop ensemble
 *  names and "da definire" placeholders (a role not yet cast). */
function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+e\s+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 2 &&
        !/orchestra|\bcoro\b|filarmonica|ensemble|da definire/i.test(s) &&
        looksLikeName(s),
    );
}

/** Italian opera seasons run autumn→summer; use the calendar year of the first
 *  performance (the festival is a single autumn edition). */
function seasonOf(date: IsoDate | null | undefined): string | null {
  return date ? date.slice(0, 4) : null;
}

/** Typographic / accented entities the shared `decodeEntities` map omits but that
 *  show up in Italian role and singer names. */
const EXTRA_ENTITIES: Record<string, string> = {
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
};

function cleanText(html: string): string {
  const pre = html.replace(/&[A-Za-z]+;/g, (m) => EXTRA_ENTITIES[m] ?? m);
  return decodeEntities(stripHtml(pre)).replace(/\s+/g, " ").trim();
}
