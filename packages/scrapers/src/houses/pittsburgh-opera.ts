import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";

/**
 * Pittsburgh Opera (`spielplan-html` strategy) — a year-round US opera company in
 * Pittsburgh, Pennsylvania (US/English), staging its mainstage season ~Oct–Apr at
 * the Benedum Center (with smaller works at the Bitz Opera Factory, CAPA/Byham
 * theaters, etc.). The live scrape walks the announced + recent seasons; `backfill`
 * appends Wikidata for the deep past.
 *
 * Bespoke ExpressionEngine site. Ticketing lives off-site on the Pittsburgh
 * Cultural Trust platform (`opera.culturaldistrict.org`, which 403s a crawler), so
 * everything comes from pittsburghopera.org SSR HTML — there is no JSON-LD /
 * __NEXT_DATA__. The `/season` index is one grid of `season-show` cards spanning
 * the upcoming seasons and a multi-year archive; each card carries the work title,
 * the multi-day performance-date string ("OCTOBER 10, 16, 18, 2026", sometimes
 * spanning two months and with a trailing venue), and a relative detail slug. The
 * detail page (`/season/{slug}`, which 302-redirects older works to
 * `/season/past-seasons/{slug}`) adds:
 *   - composer: the "Music [and libretto] by {Name}" / "Composed by {Name}" line in
 *     the `show-sub-head` (an ENGLISH structured field — NOT German composerFromText).
 *     The name may be wrapped in an `<a>`; we strip to it.
 *   - cast: "Role:&nbsp;{Name}" pairs in the `twocol` headshot cells.
 *   - creative team: "Function:&nbsp;{Name}" lines below the cast (function label
 *     mapped to our slugs INSIDE this adapter via CREATIVE_FUNCTIONS).
 * Resident-artist / debut markers (`*`, `+`, `**`) trailing a name are stripped.
 *
 * Opera filter: REQUIRE a composer. Dates come from the index card (authoritative
 * and complete; detail pages aren't always built for the upcoming season). A card
 * whose detail page has no composer line (an unbuilt upcoming page, or a non-opera
 * item) fails the gate and is dropped. No curtain times are emitted — they're only
 * on the detail page tied to dates in a fragile per-night layout.
 */

const BASE = "https://pittsburghopera.org";
const DEFAULT_VENUE = "Benedum Center";

/** Pittsburgh Opera on Wikidata — the opera COMPANY. Verified via wbsearchentities:
 *  Q7199337 = "Pittsburgh Opera", description "non-profit organization in the USA". */
const WIKIDATA_QID = "Q7199337";

/** English creative-team labels (the "Function:" line text) → our canonical function
 *  slugs. Revival/associate/assistant/original variants fold onto the principal
 *  function; unmodeled labels (Wig & Make-up, Costume Director, Stage Manager,
 *  Props, Head Carpenter, etc.) are dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "assistant conductor": "conductor",
  "music director": "conductor",
  director: "director",
  "stage director": "director",
  "production director": "director",
  "original stage director": "director",
  "original stage director / production": "director",
  "revival director": "director",
  "revival stage director": "director",
  "revival associate stage director": "director",
  "associate director": "director",
  "associate stage director": "director",
  "assistant director": "director",
  "assistant stage director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "scenic & projection designer": "set-designer",
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

interface SeasonCard {
  slug: string;
  title: string;
  dateText: string;
}

export async function scrapePittsburghOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const card of await collectSeasonCards(ctx)) {
      try {
        const html = await fetchHtml(`${BASE}/season/${card.slug}`, ctx);
        const prod = parseProduction(html, card, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`pittsburgh-opera: production ${card.slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("pittsburgh-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("pittsburgh-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "pittsburgh-opera", productions };
}

/** Parse the `/season` grid into one card per `season-show` block: its relative
 *  detail slug, the printed title, and the raw multi-day date string. Upcoming
 *  cards wrap the thumbnail in `<a href="{slug}">`; archive cards use a
 *  `<a href="{slug}" class="go">View Details</a>` link — both are relative and
 *  resolve under `/season/`. The off-site `culturaldistrict.org` Buy-Tickets and
 *  any absolute/anchor links are skipped. */
async function collectSeasonCards(ctx: FetchContext): Promise<SeasonCard[]> {
  const html = await fetchHtml(`${BASE}/season`, ctx);
  const cards: SeasonCard[] = [];
  const seen = new Set<string>();

  for (const block of html.split('<div class="season-show">').slice(1)) {
    const slug = detailSlug(block);
    if (!slug || seen.has(slug)) continue;
    const title = stripHtml(block.match(/season-show-title">([\s\S]*?)<\/p>/)?.[1] ?? "");
    const dateText = stripHtml(block.match(/season-show-date">([\s\S]*?)<\/p>/)?.[1] ?? "");
    if (!title || !dateText) continue;
    seen.add(slug);
    cards.push({ slug, title, dateText });
  }
  return cards;
}

/** The first relative, non-anchor href in a card — its detail-page slug. */
function detailSlug(block: string): string | null {
  for (const [, href] of block.matchAll(/<a href="([^"]+)"/g)) {
    const h = (href ?? "").trim();
    if (!h || h.startsWith("http") || h.startsWith("#") || h.includes("culturaldistrict")) continue;
    return h.replace(/\/+$/, "");
  }
  return null;
}

function parseProduction(
  html: string,
  card: SeasonCard,
  window: ScrapeWindow,
): RawProduction | null {
  const composer = parseComposer(html);
  // No composer line ⇒ an unbuilt upcoming detail page or a non-opera item. Gate.
  if (!composer) return null;

  const performances = parsePerformances(card.dateText, window);
  if (performances.length === 0) return null;

  const title = parseTitle(html) || decodeEntities(card.title);
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `pittsburgh-opera/${card.slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/season/${card.slug}`,
    creative_team,
    cast,
    performances,
  };
}

/** The composer sits in the `show-sub-head`: "Music by {Name}", "Music and
 *  libretto by {Name}", or "Composed by {Name}". The name may be an `<a>` link and
 *  runs to the first of: a tag, " with", "libretto", " and ", a comma, or "•". */
function parseComposer(html: string): string | null {
  const m = html.match(/(?:Music\s+(?:and\s+[Ll]ibretto\s+)?by|Composed\s+by)\s*([\s\S]*?)<br/i);
  if (!m) return null;
  let name = stripHtml(m[1] ?? "");
  name = (name.split(/\s+(?:with|libretto)\b|[,•/]|\band\b/i)[0] ?? "")
    .trim()
    .replace(/[*+;.\s]+$/g, "")
    .trim();
  return name && /[A-Za-z]/.test(name) ? name : null;
}

function parseTitle(html: string): string | null {
  const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  return h1 || null;
}

/**
 * Cast and creative team live inside the "CAST AND ARTISTIC TEAM" toggle, but in
 * two different layouts:
 *   - Cast: one `twocol` headshot cell per singer, captioning a "Role: Name" pair.
 *     The order is inconsistent across seasons — newer pages print "Role: <a>Name</a>",
 *     older pages "<a>Name</a>: Role" — so we treat the hyperlinked / resident-artist-
 *     marked (`*`/`+`) side as the person and the other as the role (see splitCastCell).
 *   - Creative team: a flat block of "Function:&nbsp;Name<br>" lines below the cells,
 *     each function label mapped to our slug via CREATIVE_FUNCTIONS (unmapped labels
 *     dropped).
 * Scoping to the toggle keeps page chrome (nav/footer "https://…" links) out.
 */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const region = creditRegion(html);
  return { cast: parseCast(region), creative_team: parseCreative(region) };
}

/** One singer per `twocol` headshot cell; the caption is a "Role: Name" pair in
 *  either order, disambiguated by splitCastCell. */
function parseCast(region: string): RawCredit[] {
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const [, cell] of region.matchAll(/<div class="(?:left|right)-col">([\s\S]*?)<\/div>/g)) {
    const pair = splitCastCell(cell ?? "");
    if (!pair) continue;
    const key = `${pair.role}|${pair.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cast.push(pair);
  }
  return cast;
}

/** Split a headshot-cell caption ("Role: Name" or "Name: Role") at its colon. We
 *  strip to plain text first so a colon inside an `href` can't split it, then pick
 *  the person side: the singer's name carries the linked text and/or a trailing
 *  resident-artist/debut marker (`*`, `+`); the bare side is the sung role. With no
 *  link on either side we keep the newer "Role: Name" order. */
function splitCastCell(cell: string): RawCredit | null {
  const linked = stripMarkers(stripHtml(cell.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ""));
  const caption = stripHtml(cell.replace(/<img[^>]*>/gi, ""));
  const colon = caption.indexOf(":");
  if (colon < 0) return null;
  const left = stripMarkers(caption.slice(0, colon));
  const right = stripMarkers(caption.slice(colon + 1));
  if (!isName(left) || !isName(right)) return null;

  const leftIsPerson =
    (linked && left.includes(linked)) || (!linked && /[*+]\s*$/.test(caption.slice(0, colon)));
  return leftIsPerson ? { role: right, name: left } : { role: left, name: right };
}

/** Drop the trailing/leading "*", "+", "**" resident-artist/debut markers. */
function stripMarkers(text: string): string {
  return text
    .replace(/[*+\s]+$/g, "")
    .replace(/^[*+\s]+/g, "")
    .trim();
}

function isName(text: string): boolean {
  return /[A-Za-z]/.test(text) && !/^TBA$/i.test(text);
}

/** The creative team is the flat run of "Function:&nbsp;Name" lines below the cast
 *  cells. Map the function label to our slug; unmapped labels are dropped. */
function parseCreative(region: string): RawCredit[] {
  const creative: RawCredit[] = [];
  const seen = new Set<string>();
  for (const [, rawLabel, rawValue] of iterLabelLines(region)) {
    const fn =
      CREATIVE_FUNCTIONS[
        stripHtml(rawLabel ?? "")
          .trim()
          .toLowerCase()
      ];
    const name = cleanName(rawValue ?? "");
    if (!fn || !name) continue;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    creative.push({ function: fn, name });
  }
  return creative;
}

/** Narrow the page to the "CAST AND ARTISTIC TEAM" toggle, where the credit lines
 *  live — bounded below by the per-debut legend or the next toggle (SYNOPSIS). */
function creditRegion(html: string): string {
  const start = html.search(/CAST AND ARTISTIC TEAM/i);
  if (start < 0) return "";
  const rest = html.slice(start);
  const end = rest.search(/Pittsburgh Opera debut|>SYNOPSIS<|class="toggle on"[^>]*>(?:(?!CAST))/i);
  return end > 0 ? rest.slice(0, end) : rest;
}

/** Yield [segment, label, value] for each "Label:&nbsp;Value" line in the creative
 *  block; the label is the plain text up to the colon, the value the remainder. */
function* iterLabelLines(html: string): Generator<[string, string, string]> {
  // Split on <br> and </p> so each yielded segment is one printed line.
  for (const segment of html.split(/<br\s*\/?>|<\/p>|<\/div>/i)) {
    // The label is the plain text right before the colon (after the last tag on the
    // line), so an "https://" inside an href can't be read as a label.
    const m = segment.match(/(?:^|>)\s*([A-Za-z][A-Za-z &/.'-]*?)\s*:(?:&nbsp;|\s)*([\s\S]*)$/);
    if (!m) continue;
    if (/^(https?|tel|mailto|margin|http)$/i.test(m[1] ?? "")) continue;
    yield [segment, m[1] ?? "", m[2] ?? ""];
  }
}

/** Strip tags/entities and the trailing "*", "+", "**" resident-artist/debut markers. */
function cleanName(html: string): string {
  const text = stripHtml(html)
    .replace(/[*+]+$/g, "")
    .trim();
  return /[A-Za-z]/.test(text) && !/^TBA$/i.test(text) ? text : "";
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/**
 * The index date string is one or more days under a running month, with the year
 * at the end, e.g.:
 *   "OCTOBER 10, 16, 18, 2026"
 *   "FEBRUARY 27, MARCH 2, 5, 7, 2027"           (month changes mid-string)
 *   "March 16, 19, 22 & 24, 2024 Benedum Center" (trailing venue + & separator)
 *   "Mar. 26, 29 & Apr. 1, 3, 2022"              (abbreviated months)
 * We scan left to right, carrying the most recent month token, and emit one
 * performance per day number. A trailing venue (after the year) sets venue_room.
 */
function parsePerformances(dateText: string, window: ScrapeWindow): RawPerformance[] {
  const year = dateText.match(/\b(\d{4})\b/)?.[1];
  if (!year) return [];

  const venue = dateText.slice(dateText.indexOf(year) + 4).trim() || DEFAULT_VENUE;
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  let month: string | null = null;
  // Token stream of month words/abbreviations, the 4-digit year (ignored as a
  // day), and bare day numbers, in order. The year alternative is listed before
  // the 1–2-digit day so "2026" isn't chopped into "20" + "26".
  for (const [, word, , day] of dateText.matchAll(/([A-Za-z]{3,9})\.?|(\d{4})|(\d{1,2})/g)) {
    if (word) {
      const m = MONTHS[word.slice(0, 3).toLowerCase()];
      if (m) month = m;
      continue;
    }
    if (!day || !month) continue;
    const date = isoFromParts(year, month, day);
    if (!date) continue;
    if (window.since && date < window.since) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({
      date,
      venue_room: venue,
      status: date < today ? "past" : "scheduled",
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
