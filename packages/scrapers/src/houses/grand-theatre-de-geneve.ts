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
 * Grand Théâtre de Genève (`spielplan-html` strategy) — Switzerland's largest
 * stage, presenting opera, ballet and recitals at the Grand Théâtre (place de
 * Neuve) and the Bâtiment des Forces Motrices (BFM). FRENCH-language WordPress
 * site with an /en mirror; we read the FRENCH pages so the printed credit labels
 * map through CREDIT_LABELS below.
 *
 * Genre lives in the season grid: each show card is a `.item` with a
 * `data-theme` ("opera", "ballet", "recital", "laplage", …); we keep only the
 * cards whose theme includes "opera" and harvest the card's slug, title and
 * composer (the `.description` line). Galas slip into the opera theme (a "Glam
 * Night" after-party whose description is "À l'issue de …" rather than a
 * composer); the composer gate drops them.
 *
 * Two reads:
 *   - The season grids `/saison-{YY-YY}/` (discovered from the homepage) list
 *     every show as a `.item[data-theme]` card with `.titre`, `.description`
 *     (composer) and a `.date` range, linking the detail page `/saison-{YY-YY}/
 *     {slug}/`.
 *   - Each detail page is server-rendered and plain-fetchable. Its main prose
 *     block carries, in order: an intro line "Opéra de {composer}"; a bold date
 *     block grouping performance days by month with the call time ("23, 25, 28 et
 *     30 avril, 2 mai 2026 – 19h30") and the venue ("Au Bâtiment des Forces
 *     Motrices"); a "DISTRIBUTION" paragraph of "{label} {name}" creative-team
 *     lines (French labels mapped here); and cast paragraphs of "{role} {name}"
 *     lines (alternates separated by "|", with per-date notes in parentheses we
 *     drop).
 *
 * Performances are parsed from that French date prose (the booking calendar's
 * per-night links sit only on the homepage, not the detail page). `backfill`
 * appends Wikidata for the deep past.
 */

const BASE = "https://www.gtg.ch";
/** Grand Théâtre de Genève on Wikidata — the production COMPANY (Q50928969,
 *  "theatre production company in Geneva"), NOT the opera-house building
 *  (Q555398). The company carries the productions: a P4647/P272 SPARQL count
 *  returns 993 works for Q50928969 versus 4 for the building. Verified via
 *  wbsearchentities (search="Grand Théâtre de Genève", fr → both QIDs) +
 *  wbgetentities (P31 / descriptions) + the production-count query. */
const WIKIDATA_QID = "Q50928969";

/** French DISTRIBUTION labels → our canonical function slugs. An unmapped label
 *  is dropped rather than guessed. */
const CREDIT_LABELS: Record<string, string> = {
  "direction musicale": "conductor",
  "mise en scène": "director",
  décors: "set-designer",
  scénographie: "set-designer",
  costumes: "costume-designer",
  lumières: "lighting",
  éclairages: "lighting",
  chorégraphie: "choreographer",
  chorégraphe: "choreographer",
  "chef des chœurs": "chorus-master",
  "cheffe des chœurs": "chorus-master",
  "direction des chœurs": "chorus-master",
  dramaturgie: "dramaturgy",
};

/** French month name → 1-based month number. */
const MONTHS: Record<string, number> = {
  janvier: 1,
  janv: 1,
  février: 2,
  fevrier: 2,
  févr: 2,
  fevr: 2,
  mars: 3,
  avril: 4,
  avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  juil: 7,
  août: 8,
  aout: 8,
  septembre: 9,
  sept: 9,
  octobre: 10,
  oct: 10,
  novembre: 11,
  nov: 11,
  décembre: 12,
  decembre: 12,
  déc: 12,
  dec: 12,
};

export async function scrapeGrandTheatreDeGeneve(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const { season, slug } of await collectOperaShows(ctx)) {
      try {
        const prod = await buildProduction(ctx, season, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`grand-theatre-de-geneve: show ${season}/${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("grand-theatre-de-geneve: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("grand-theatre-de-geneve: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "grand-theatre-de-geneve", productions };
}

interface ShowRef {
  season: string;
  slug: string;
}

/** Discover announced seasons from the homepage, then read each season grid and
 *  keep the opera-theme cards (deduped by season/slug). */
async function collectOperaShows(ctx: FetchContext): Promise<ShowRef[]> {
  const shows = new Map<string, ShowRef>();
  for (const season of await collectSeasons(ctx)) {
    try {
      const html = await fetchHtml(`${BASE}/saison-${season}/`, ctx);
      for (const slug of operaSlugs(html)) {
        shows.set(`${season}/${slug}`, { season, slug });
      }
    } catch (err) {
      console.warn(`grand-theatre-de-geneve: season ${season} index failed:`, err);
    }
  }
  return [...shows.values()];
}

/** The announced seasons (e.g. "25-26", "26-27") linked from the homepage. */
async function collectSeasons(ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(`${BASE}/`, ctx);
  const seasons = new Set<string>();
  for (const [, s] of html.matchAll(/saison-(\d{2}-\d{2})/g)) if (s) seasons.add(s);
  return [...seasons];
}

/** Slugs of the season grid's opera-theme cards. Each card is a
 *  `<div class="item " data-theme="…">…<a href="…/saison-{YY-YY}/{slug}/"…>`.
 *  We keep cards whose theme word-set includes "opera". */
function operaSlugs(html: string): string[] {
  const slugs: string[] = [];
  for (const [, theme, slug] of html.matchAll(
    /<div class="item\s*"\s+data-theme="([^"]*)">[\s\S]*?<a href="https:\/\/www\.gtg\.ch\/saison-\d{2}-\d{2}\/([a-z0-9-]+)\/"/g,
  )) {
    if (!theme || !slug) continue;
    if (theme.split("|").includes("opera")) slugs.push(slug);
  }
  return slugs;
}

async function buildProduction(
  ctx: FetchContext,
  season: string,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/saison-${season}/${slug}/`;
  const html = await fetchHtml(detailUrl, ctx);

  const block = mainProseBlock(html);
  if (!block) return null;

  const composer = parseComposer(block);
  // No "Opéra de {composer}" intro ⇒ not a staged opera (gala / after-party). The opera gate.
  if (!composer) return null;

  const title = parseTitle(html, slug);
  if (!title) return null;

  const performances = parsePerformances(block, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseTeam(block);

  return {
    source_production_id: `grand-theatre-de-geneve/${season}/${slug}`,
    work_title: title,
    composer_name: composer,
    premiere_season: `20${season.replace("-", "/20")}`,
    detail_url: detailUrl,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** The detail page's main prose container `<div class="texte main">…</div>`,
 *  which holds the composer line, date block, DISTRIBUTION and cast. */
function mainProseBlock(html: string): string | null {
  const start = html.indexOf('class="texte main"');
  if (start < 0) return null;
  // The cast/credits live early in this container; an 8 KB slice covers them
  // without dragging in the trailing synopsis/marketing prose.
  return html.slice(start, start + 8000);
}

/** Composer from the "Opéra de {X}" / "Opéra d'{X}" intro line. */
function parseComposer(block: string): string | null {
  const m = block.match(/Op[ée]ra\s+(?:de|d['’]|d&rsquo;|d&#8217;)\s*([\s\S]*?)<\/(?:strong|p)>/i);
  const name = m ? stripHtml(decodeEntities(m[1] ?? "")) : "";
  return name || null;
}

function parseTitle(html: string, slug: string): string {
  const h1 = stripHtml(decodeEntities(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? ""));
  if (h1) return h1;
  const og = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  if (og) return stripHtml(decodeEntities(og)).replace(/\s*[-–]\s*Grand Théâtre.*$/i, "");
  return slugToTitle(slug);
}

function ogImage(html: string): string | null {
  return html.match(/<meta property="og:image" content="([^"]*)"/)?.[1] ?? null;
}

/** The DISTRIBUTION block is one `<p>` of `<br />`-separated creative lines
 *  ("{French label} <strong>{name}</strong>"), followed by separate `<p>` blocks
 *  of cast lines ("{role} <strong>{name}</strong> | <strong>{alt}</strong>"). We
 *  read the heading's paragraph as creative team and the next paragraphs as cast.
 *  Compound labels ("Mise en scène et chorégraphie") split on " et "/"&"/"," and
 *  map per segment; an unmapped creative label is dropped. */
function parseTeam(block: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const distIdx = block.search(/DISTRIBUTION/i);
  if (distIdx < 0) return { creative_team: [], cast: [] };

  const paras = block.slice(distIdx).split(/<\/p>/);
  const creative_team = parseCreative(paras[0] ?? "");
  // Cast paragraphs run until the ensembles paragraph (just bold names, no role
  // prefix — chorus/orchestra) or trailing marketing prose; 4 paragraphs covers
  // the principals and supporting roles without dragging in the synopsis.
  const cast = parseCast(paras.slice(1, 5));
  return { creative_team, cast };
}

function parseCreative(para: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const line of para.split(/<br\s*\/?>/i)) {
    const names = strongNames(line);
    if (names.length === 0) continue;
    const label = lineLabel(line);
    for (const fn of mapCreativeLabel(label)) {
      for (const name of names) {
        const key = `${fn}|${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ function: fn, name });
      }
    }
  }
  return out;
}

function parseCast(paras: string[]): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const para of paras) {
    for (const line of para.split(/<br\s*\/?>/i)) {
      const names = strongNames(line);
      const role = lineLabel(line);
      // Ensemble lines (chorus/orchestra) carry a name but no role prefix — skip.
      if (names.length === 0 || !role) continue;
      for (const name of names) {
        const key = `${role}|${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ role, name });
      }
    }
  }
  return out;
}

/** The `<strong>`-wrapped names in a line (cast alternates / co-credits). */
function strongNames(line: string): string[] {
  return [...line.matchAll(/<strong>([\s\S]*?)<\/strong>/g)]
    .map((m) => stripHtml(decodeEntities(m[1] ?? "")))
    .filter(Boolean);
}

/** The label/role text of a line: everything outside the `<strong>` names, minus
 *  the DISTRIBUTION heading, per-date parentheticals and alternate separators. */
function lineLabel(line: string): string {
  return stripHtml(decodeEntities(line.replace(/<strong>[\s\S]*?<\/strong>/g, " ")))
    .replace(/DISTRIBUTION/i, "")
    .replace(/[|(].*$/, "")
    .replace(/[\s,&]+$/, "")
    .replace(/^[\s,&]+/, "")
    .trim();
}

/** Split a (possibly compound) French label into mapped function slugs. */
function mapCreativeLabel(label: string): string[] {
  const key = label.toLowerCase();
  const direct = CREDIT_LABELS[key];
  if (direct) return [direct];
  const fns = new Set<string>();
  for (const seg of key.split(/\s*(?:,|\bet\b|&|&amp;)\s*/)) {
    const fn = CREDIT_LABELS[seg.trim()];
    if (fn) fns.add(fn);
  }
  return [...fns];
}

/** Parse the bold date block (before DISTRIBUTION) into dated performances. Each
 *  line groups days by month and ends with a call time, e.g.
 *  "23, 25, 28 et 30 avril, 2 mai 2026 – 19h30"; the venue follows as
 *  "Au {venue}". Honors window.since. */
function parsePerformances(block: string, window: ScrapeWindow): RawPerformance[] {
  const distIdx = block.search(/DISTRIBUTION/i);
  const head = distIdx >= 0 ? block.slice(0, distIdx) : block;
  const text = stripHtml(decodeEntities(head));
  const venue =
    text
      .match(/\bAu\s+([A-ZÉ][^|]*?)(?:\s+(?:Durée|Chanté|Accès|Recommand|Spectacle|>)|$)/)?.[1]
      ?.replace(/\s*\d.*$/, "")
      .trim() || null;
  const today = new Date().toISOString().slice(0, 10);

  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const { date, time } of parseDatePhrases(text)) {
    if (window.since && date < window.since) continue;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, venue_room: venue, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

interface DatedPerf {
  date: IsoDate;
  time: string | null;
}

/** Scan the date prose into `(date, time)` pairs. The prose lists days grouped by
 *  month, the year, then the call time: "23, 25, 28 et 30 avril, 2 mai 2026 –
 *  19h30". Each phrase is matched as a strict run of day-number / month-word /
 *  ","/"et" tokens ending in "YYYY – HHh[MM]", so stray words (an archive note
 *  like "2012-2013", "Nouvelle production") break the run and are skipped. */
function parseDatePhrases(text: string): DatedPerf[] {
  const out: DatedPerf[] = [];
  const PHRASE =
    /((?:\d{1,2}|janv\w*|févr\w*|fevr\w*|mars|avr\w*|mai|juin|juil\w*|août|aout|sept\w*|oct\w*|nov\w*|déc\w*|dec\w*|et|[,’'.])(?:\s+|\s*[,]\s*)?)+(20\d\d)\s*[–-]\s*(\d{1,2})h(\d{2})?/gi;
  for (const m of text.matchAll(PHRASE)) {
    const phrase = m[0];
    const year = Number(m[2]);
    const time = `${(m[3] ?? "").padStart(2, "0")}:${m[4] ?? "00"}`;
    for (const date of expandPhrase(phrase, year)) out.push({ date, time });
  }
  return out;
}

/** Expand "23, 25, 28 et 30 avril, 2 mai" + year → ISO dates. Days precede the
 *  month they belong to; pending days flush when a month word appears. */
function expandPhrase(phrase: string, year: number): IsoDate[] {
  const dates: IsoDate[] = [];
  let pending: number[] = [];
  for (const tok of phrase.matchAll(/(\d{1,2})|([a-zéûôà]+)/gi)) {
    const num = tok[1];
    const word = tok[2]?.toLowerCase();
    if (num) {
      const n = Number(num);
      if (n >= 1 && n <= 31) pending.push(n);
      continue;
    }
    const month = word ? MONTHS[word] : undefined;
    if (!month) continue;
    for (const d of pending) {
      dates.push(
        `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}` as IsoDate,
      );
    }
    pending = [];
  }
  return dates;
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
