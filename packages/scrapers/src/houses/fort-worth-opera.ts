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
import { isoFromParts } from "./_dates";

/**
 * Fort Worth Opera (`spielplan-html` strategy) — the oldest opera company in
 * Texas (US/English), a smaller, festival-leaning house whose mainstage operas
 * play Bass Performance Hall (the season also tours smaller Fort Worth venues:
 * Ridglea Theater, Stage West, Ed Landreth at TCU). The live scrape reads the
 * announced season; `backfill` walks the site's own production archive and then
 * appends Wikidata for the deep past.
 *
 * Wix site (no Tessitura; ticketing is off-site). There is NO Event JSON-LD and
 * no JSON API — each production is a hand-built marketing page at `/{slug}` whose
 * content lives in server-rendered Wix rich-text. The pages are not uniform, so
 * the parser targets the recurring signals rather than a fixed template:
 *   - composer (the opera gate): "Music [and libretto] by {Name}", a
 *     "{Name}, composer" credit line, or the possessive "{Composer}'s {Title}"
 *     lede — an ENGLISH name string (NOT the German composerFromText).
 *   - performances: date lines ("Friday, April 16, 2027, 7:30 p.m." /
 *     "April 18, 2026 - 7:00 PM" / "December 12, 2026, 11:00 a.m. and 4:00 p.m.")
 *     plus a venue line ("Bass Performance Hall", "Ridglea Theater", …). Tickets
 *     are off-site, so status is past/scheduled by date.
 *   - cast + creative team: a "CAST AND CREATIVES" / "Meet the Cast" block. Most
 *     pages render label↔value pairs in a Wix repeater (parsed from listitems);
 *     the rest render them as a plain rich-text run of "{label}\n{name}" pairs
 *     plus a "{Name}, {function}" credit form. English function labels are mapped
 *     to our slugs INSIDE this adapter (see CREATIVE_FUNCTIONS); anything else is
 *     treated as a sung role (cast). Some pages embed the cast in a client-only
 *     widget (`<div id="…-cast-creatives">`), so empty credit arrays are normal.
 *
 * Opera filter: REQUIRE a composer AND ≥1 dated performance. Concerts, galas,
 * competitions and fundraisers (Jeanine De Bique in Concert, Art Worth Festival,
 * the McCammon Voice Competition) publish neither and drop out by construction.
 *
 * Backfill: the site's Wix Data archive collection lists every past production at
 * `/archive/{slug}` (title + composer + year, cast/dates on recent entries) —
 * richer than Wikidata for this house. The `dynamic-archive` sitemap enumerates
 * the collection; each item yields title + composer + a premiere year.
 */

const BASE = "https://www.fwopera.org";
const SITEMAP_INDEX = `${BASE}/sitemap.xml`;

/** Fort Worth Opera on Wikidata — the opera COMPANY. Verified via
 *  wbsearchentities: Q5472398 = "Fort Worth Opera", description "opera company
 *  in Fort Worth, Texas, USA". */
const WIKIDATA_QID = "Q5472398";

/** English creative-team function labels → our canonical function slugs.
 *  Assistant/associate/revival variants fold onto the principal function;
 *  unmapped labels (Wig/Makeup designers, "Pianist", etc.) are dropped rather
 *  than guessed. Anything not here is read as a sung role and kept as cast. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  "music director": "conductor",
  "musical director": "conductor",
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

export async function scrapeFortWorthOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  const seen = new Set<string>();

  try {
    for (const slug of await collectSeasonSlugs(ctx)) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      try {
        const prod = parseProduction(await fetchHtml(`${BASE}/${slug}`, ctx), slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`fort-worth-opera: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("fort-worth-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeArchive(ctx, window)));
    } catch (err) {
      console.warn("fort-worth-opera: archive backfill failed:", err);
    }
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("fort-worth-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "fort-worth-opera", productions };
}

/** Slugs of the announced-season production pages. The homepage nav lists the
 *  running season; the `pages` sitemap carries every custom `/{slug}` page (recent
 *  past + just-announced), so the union catches productions the nav has rolled off.
 *  Non-opera pages (about, support-us, archive items, concerts) drop out at the
 *  opera gate in `parseProduction`. */
async function collectSeasonSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();

  try {
    for (const [, slug] of (await fetchHtml(`${BASE}/`, ctx)).matchAll(
      /href="https:\/\/www\.fwopera\.org\/([a-z0-9][a-z0-9-]*)"/g,
    )) {
      if (slug && !NON_PRODUCTION_SLUGS.has(slug)) slugs.add(slug);
    }
  } catch (err) {
    console.warn("fort-worth-opera: homepage index failed:", err);
  }

  try {
    for (const loc of await pagesSitemapLocs(ctx)) {
      const slug = loc.match(/^https:\/\/www\.fwopera\.org\/([a-z0-9][a-z0-9-]*)$/)?.[1];
      if (slug && !NON_PRODUCTION_SLUGS.has(slug)) slugs.add(slug);
    }
  } catch (err) {
    console.warn("fort-worth-opera: pages sitemap failed:", err);
  }

  return [...slugs];
}

/** Static, never-a-production pages (org info, ticketing, programs). Filtering them
 *  up front avoids dozens of pointless fetches; the opera gate is the real guard. */
const NON_PRODUCTION_SLUGS = new Set([
  "about",
  "auditions",
  "blog",
  "booking-form",
  "community-learning",
  "faces-of-fwo",
  "financials",
  "fwo-press",
  "historical-timeline",
  "jobs",
  "match-the-momentum",
  "opera-ambassadors",
  "performances",
  "plan-your-visit",
  "privacypolicy",
  "referral",
  "repertoire-list",
  "student-discount-programs",
  "subscriptions-26-27",
  "support-us",
  "team",
  "terms-conditions",
  "the-mccammon-competition",
  "ticket-policy",
  "video-archive",
]);

/** The Wix sitemap index points at a `pages-sitemap.xml` (custom pages) and a
 *  `dynamic-archive_…-sitemap.xml` (the archive collection). Returns the loc URLs
 *  of the named sub-sitemap. */
async function subSitemapLocs(ctx: FetchContext, match: RegExp): Promise<string[]> {
  const index = await fetchHtml(SITEMAP_INDEX, ctx);
  const subUrl = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(([, u]) => u ?? "")
    .find((u) => match.test(u));
  if (!subUrl) return [];
  const xml = await fetchHtml(subUrl, ctx);
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, u]) => decodeEntities(u ?? ""));
}

const pagesSitemapLocs = (ctx: FetchContext) => subSitemapLocs(ctx, /pages-sitemap\.xml$/);

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const lines = textLines(html);
  const title = pageTitle(html);
  if (!title) return null;

  const composer = parseComposer(html, lines, title);
  // No composer ⇒ a concert/gala/competition/org page, not staged opera. Opera gate.
  if (!composer) return null;

  const performances = parsePerformances(lines, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html, lines);

  return {
    source_production_id: `fort-worth-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    language: languageCode(lines),
    detail_url: `${BASE}/${slug}`,
    creative_team,
    cast,
    performances,
  };
}

/** The work title is the page `<title>` minus the " | Fort Worth Opera" suffix. */
function pageTitle(html: string): string | null {
  const raw = decodeEntities(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "").trim();
  const title = raw.replace(/\s*[|–-]\s*Fort Worth Opera\s*$/i, "").trim();
  if (!title || /^(404|home)\b/i.test(title)) return null;
  return title;
}

/**
 * The composer, in priority order:
 *   1. "Music [and libretto] by {Name}" — the explicit production credit.
 *   2. a "{Name}, composer[ and librettist]" credit line in the creatives block.
 *   3. the possessive lede "{Composer}'s {Title}" (also in og:description) — the
 *      common prose form on pages with no explicit credit (e.g. Madama Butterfly).
 */
function parseComposer(html: string, lines: string[], title: string): string | null {
  const text = lines.join("\n");

  const byCredit = text.match(/Music\s+(?:and\s+libretto\s+)?by\s+([A-Z][A-Za-zÀ-ž.'’ -]{3,40})/);
  if (byCredit?.[1]) return cleanName(byCredit[1]);

  const named = text.match(
    /([A-Z][A-Za-zÀ-ž.'’-]+(?:\s+[A-Z][A-Za-zÀ-ž.'’-]+){1,3}),\s*composer\b/,
  );
  if (named?.[1]) return cleanName(named[1]);

  const lead =
    title
      .split(/[:/]/)[0]
      ?.trim()
      .replace(/\s*\d{4}$/, "") ?? title;
  const haystack = `${html.match(/property="og:description"\s+content="([^"]*)"/i)?.[1] ?? ""}\n${text}`;
  const escaped = lead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const possessive = haystack.match(
    new RegExp(`([A-Z][A-Za-zÀ-ž.'’-]+(?:\\s+[A-Z][A-Za-zÀ-ž.'’-]+){1,3})['’]s\\s+${escaped}`),
  );
  if (possessive?.[1]) return cleanName(possessive[1]);

  return null;
}

function cleanName(name: string): string {
  return stripHtml(decodeEntities(name))
    .replace(/[*+]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/**
 * Performance rows from the page's date lines. The same date can carry one or
 * more times ("…11:00 a.m. and 4:00 p.m."); each (date, time) is its own row.
 * Venue is the first venue-like line on the page; status is by date.
 */
function parsePerformances(lines: string[], window: ScrapeWindow): RawPerformance[] {
  const venue = parseVenue(lines);
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const dm = line.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (!dm) continue;
    const month = MONTHS[(dm[1] ?? "").toLowerCase()];
    if (!month) continue;
    const date = isoFromParts(dm[3] ?? "", month, dm[2] ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;

    const times = [...line.matchAll(/(\d{1,2}):(\d{2})\s*([ap])\.?\s*m/gi)];
    const hhmms = times.length ? times.map((t) => to24h(t[1], t[2], t[3])) : [null];
    for (const time of hhmms) {
      const key = `${date}|${time ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        date,
        time,
        venue_room: venue,
        status: date < today ? "past" : "scheduled",
      });
    }
  }
  // A date mentioned both with and without a time (a timed listing plus a prose
  // reference) yields a spurious null-time row — drop it when the date is timed.
  const timedDates = new Set(out.filter((p) => p.time).map((p) => p.date));
  return out
    .filter((p) => p.time || !timedDates.has(p.date))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}

function to24h(h?: string, m?: string, meridian?: string): string {
  let hour = Number.parseInt(h ?? "", 10);
  const md = (meridian ?? "").toLowerCase();
  if (md === "p" && hour !== 12) hour += 12;
  if (md === "a" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m}`;
}

const VENUE_RE =
  /\b(Bass Performance Hall|Ridglea Theater|Stage West|Van Cliburn|Ed Landreth|Scott Theatre|McDavid Studio|Will Rogers)\b[^,\n]*/i;

function parseVenue(lines: string[]): string | null {
  for (const line of lines) {
    const m = line.match(VENUE_RE);
    if (m) return cleanName(m[0]);
  }
  return null;
}

/**
 * Cast + creative team from the "CAST AND CREATIVES" / "Meet the Cast" block.
 * Two render forms; the repeater is preferred when present (it keeps multi-word
 * names intact, which the line stream splits across spans):
 *   - a Wix repeater of `role="listitem"` cells, each a {label, value} pair;
 *   - a plain rich-text run of alternating "{label}\n{name}" lines, plus a
 *     "{Name}, {function}" credit form.
 * A label that maps to a CREATIVE_FUNCTION is creative; everything else is a
 * sung role (cast). "to be announced" placeholders are dropped.
 */
function parseCredits(
  html: string,
  lines: string[],
): { creative_team: RawCredit[]; cast: RawCredit[] } {
  // When a repeater is present it owns the label↔value pairs (and keeps multi-word
  // names intact, which the line stream splits across spans); the line stream then
  // only contributes the "{Name}, {function}" credit block that lives outside it.
  // With no repeater, the line stream provides everything.
  const repeater = repeaterPairs(html);
  return toCredits([...repeater, ...textPairs(lines, { commaOnly: repeater.length > 0 })]);
}

/** {label, value} pairs from a Wix repeater scoped to the cast block. */
function repeaterPairs(html: string): Array<[string, string]> {
  const idx = html.search(/CAST AND CREATIVES|Meet the Cast/i);
  if (idx < 0) return [];
  const region = html.slice(idx);
  if (!/role="listitem"/.test(region)) return [];

  const pairs: Array<[string, string]> = [];
  for (const item of region.split(/role="listitem"/).slice(1)) {
    // Clamp each cell: a repeater item's text ends before the next sibling block
    // or the "ACCOMPANIED BY / CAST / debut" footer, which the final cell's regex
    // would otherwise swallow.
    // A cell is one {label, value} pair. The final cell bleeds the sibling content
    // that follows the repeater (a separate CAST/CREATIVE list), so keep only the
    // distinct label + the words of the single name that follow it — bounded by the
    // listitem's own closing markup.
    const cell = item.split(/<\/h5>|denotes FWOpera|Mainstage debut|ACCOMPANIED/i)[0] ?? "";
    const texts = [
      ...new Set(
        [...cell.matchAll(/class="wixui-rich-text__text">([^<]+)<\/span>/g)]
          .map(([, t]) => cleanName(t ?? ""))
          .filter(Boolean),
      ),
    ];
    if (texts.length >= 2) pairs.push([texts[0] ?? "", texts.slice(1).join(" ")]);
  }
  return pairs;
}

/** {label, value} pairs from the plain rich-text line run after the cast heading.
 *  Handles both "{label}\n{name}" alternation and the "{Name}, {function}" form. */
function textPairs(lines: string[], opts: { commaOnly?: boolean } = {}): Array<[string, string]> {
  const idx = lines.findIndex((l) => /CAST AND CREATIVES|Meet the Cast/i.test(l));
  if (idx < 0) return [];
  let seg = lines.slice(idx + 1);
  const end = seg.findIndex((l) => /denotes FWOpera debut|Mainstage debut/i.test(l));
  if (end >= 0) seg = seg.slice(0, end);

  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < seg.length; i++) {
    const line = seg[i] ?? "";
    const comma = line.match(/^(.+?),\s*([a-z][a-z /&-]+?)\*?\+?$/);
    if (comma && CREATIVE_FUNCTIONS[comma[2]?.trim().toLowerCase() ?? ""]) {
      pairs.push([comma[2] ?? "", comma[1] ?? ""]);
      continue;
    }
    if (opts.commaOnly) continue;
    // Section captions ("CAST", "CREATIVE", "ENSEMBLE") aren't labels; skip them
    // so the alternation stays aligned.
    if (/^(cast|creative|ensemble)[\s&]*$/i.test(line)) continue;
    const next = seg[i + 1];
    if (next && !/^(cast|creative|ensemble)/i.test(next) && !/,\s*[a-z]/.test(next)) {
      pairs.push([line, next]);
      i++;
    }
  }
  return pairs;
}

function toCredits(pairs: Array<[string, string]>): {
  creative_team: RawCredit[];
  cast: RawCredit[];
} {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const [label, rawName] of pairs) {
    const name = cleanName(rawName);
    if (!name || /to be announced|tba|full cast/i.test(name)) continue;
    const fn = CREATIVE_FUNCTIONS[label.trim().toLowerCase()];
    if (fn) {
      const key = `c|${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    } else {
      const role = cleanName(label);
      if (!role || /^(accompanied|cast|creative|ensemble|address|contact)/i.test(role)) continue;
      const key = `r|${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role, name });
    }
  }
  return { creative_team, cast };
}

const LANGUAGES: Record<string, RawProduction["language"]> = {
  italian: "it",
  english: "en",
  german: "de",
  french: "fr",
  russian: "ru",
  czech: "cs",
  spanish: "es",
};

/** "In Italian, with English supertitles" / "Sung in English" → ISO 639-1. */
function languageCode(lines: string[]): RawProduction["language"] {
  for (const line of lines) {
    const m = line.match(/(?:Sung\s+in|^In)\s+([A-Za-z]+)/i);
    const code = m?.[1] ? LANGUAGES[m[1].toLowerCase()] : undefined;
    if (code) return code;
  }
  return null;
}

/** Strip Wix markup to a clean, footer/nav-trimmed line stream. */
function textLines(html: string): string[] {
  const body = decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, "\n"),
  );
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && l.length < 200 && !/^[{}.@:#[]/.test(l));

  const start = lines.findIndex((l) => /Use tab to navigate/i.test(l));
  const sliced = start >= 0 ? lines.slice(start + 1) : lines;
  const end = sliced.findIndex((l) => /^(ADDRESS|CONTACT|FOLLOW US)$|Powered and secured/i.test(l));
  return end >= 0 ? sliced.slice(0, end) : sliced;
}

// ── Backfill: the site's own production archive (Wix Data collection) ────────

/**
 * Walk the `/archive/{slug}` collection enumerated by the `dynamic-archive`
 * sitemap. Each archive page renders the item as a clean run: title, composer,
 * year, then (on recent entries) cast/creative labels + a date line. We take the
 * reliable trio — title, composer, year — which is enough to seed a production
 * and anchor resolution; richer fields are left to the live leg / Wikidata.
 */
async function scrapeArchive(ctx: FetchContext, window: ScrapeWindow): Promise<RawProduction[]> {
  const out: RawProduction[] = [];
  const locs = await subSitemapLocs(ctx, /dynamic-archive_.*-sitemap\.xml$/);

  for (const loc of locs) {
    const slug = loc.match(/\/archive\/(.+)$/)?.[1];
    if (!slug) continue;
    try {
      const prod = parseArchiveItem(await fetchHtml(loc, ctx), slug, window);
      if (prod) out.push(prod);
    } catch (err) {
      console.warn(`fort-worth-opera: archive item ${slug} failed:`, err);
    }
  }
  return out;
}

/** An archive page leads with "{Title}\n{Composer}\n{Year}" after a "Back to
 *  list" link. Composer is the opera gate; the year becomes the premiere date. */
function parseArchiveItem(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const lines = textLines(html);
  const back = lines.findIndex((l) => /Back to list/i.test(l));
  const head = back >= 0 ? lines.slice(back + 1) : lines;

  const title = cleanName(head[0] ?? "");
  const composer = cleanName(head[1] ?? "");
  const yearLine = head.slice(2, 6).find((l) => /^\d{4}$/.test(l));
  if (!title || !composer || !/[A-Za-z]/.test(composer) || !yearLine) return null;
  // The composer line must look like a person's name (Latin incl. Extended-A for
  // names like Antonín Dvořák), not a stray caption.
  if (!/^[A-ZÀ-Ž][A-Za-zÀ-ž.'’ -]+$/.test(composer) || composer.split(" ").length > 5) return null;

  const year = Number.parseInt(yearLine, 10);
  const premiereDate = `${year}-01-01` as IsoDate;
  if (window.since && premiereDate < window.since) return null;

  return {
    source_production_id: `fort-worth-opera/archive/${slug}`,
    work_title: title,
    composer_name: composer,
    premiere_date: premiereDate,
    premiere_season: String(year),
    detail_url: `${BASE}/archive/${slug}`,
    performances: [{ date: premiereDate, status: "past" }],
  };
}
