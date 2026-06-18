import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchJson } from "../fetch";
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
 * Opéra de Rouen Normandie (`spielplan-html` strategy) —
 * operaorchestrenormandierouen.fr (the rebranded operaderouen.fr). WordPress,
 * REST API open. Discovery + the opera gate come from the `spectacle` CPT REST
 * endpoint filtered to the `genre` taxonomy term for staged opera (215, "Opéra")
 * — the house mixes concerts/dance/territory tags into the same taxonomy, so the
 * term filter is what separates lyric productions from the orchestral season.
 * The REST payload's `acf` is empty and its `content` is only a blurb, so every
 * fact comes from the `/programmation/<slug>/` detail page:
 *   - title: the REST `title.rendered` (cleaner than the page markup);
 *   - composer: `<h2 class="event-title">…</h2>` (the work's composer byline);
 *   - performances: the `<h3 class="short">Venue</h3><p>…</p>` blocks — each `<br>`
 *     line is "Weekday DD month YYYY à HHhMM" (full year, so no inference); the
 *     non-date blocks ("Durée", "Tarif …") simply don't match the line pattern;
 *   - distribution (`<div class="event-distribution">`): a creative credit is
 *     `Label <b>Name</b>` (label is plain/`<span>` text), a cast credit is
 *     `<i>Role</i> <b>Name</b>` (the `<i>` marks a sung character); ensemble lines
 *     (orchestre / chœur / danseurs) carry no role and no mappable label → dropped.
 *
 * Live "Opéra en direct" cinema broadcasts are tagged opera too — excluded by
 * slug, since they duplicate the staged production. Deep past comes from
 * Wikidata (Q111297694) in backfill mode.
 */

const BASE = "https://www.operaorchestrenormandierouen.fr";
const REST_SPECTACLE = `${BASE}/wp-json/wp/v2/spectacle`;
/** `genre` taxonomy term for staged opera — the server-side opera gate. */
const OPERA_GENRE_ID = 215;
/** Opéra de Rouen Normandie — verified via wbgetentities: Q111297694, P17 = France. */
const WIKIDATA_QID = "Q111297694";

const RECENT_PAST_DAYS = 45;
const PER_PAGE = 100;
const MAX_PAGES = 6;

const MONTHS: Record<string, string> = {
  janvier: "01",
  février: "02",
  fevrier: "02",
  mars: "03",
  avril: "04",
  mai: "05",
  juin: "06",
  juillet: "07",
  août: "08",
  aout: "08",
  septembre: "09",
  octobre: "10",
  novembre: "11",
  décembre: "12",
  decembre: "12",
};

/** French creative-function labels → canonical function keys, tested in order. */
const CREATIVE_LABELS: [RegExp, string][] = [
  [/chef?fe?\s+de\s+ch[œoe]ur|direction\s+du\s+ch[œoe]ur/i, "chorus-master"],
  [/chef?fe?\s+de\s+chant/i, "repetiteur"],
  [/direction\s+musicale|chef?fe?\s+d['’]orchestre/i, "conductor"],
  [/mise\s+en\s+sc[èe]ne/i, "director"],
  [/chor[ée]graph/i, "choreographer"],
  [/lumi[èe]res?|[ée]clairages?/i, "lighting"],
  [/sc[ée]nographie|d[ée]cors?/i, "set-designer"],
  [/costumes?/i, "costume-designer"],
  [/dramaturg/i, "dramaturgy"],
  [/vid[ée]o/i, "video"],
];

/** Cast/ensemble lines that are not a sung character. */
const ENSEMBLE = /orchestre|ch[œoe]ur|ensemble|ballet|ma[îi]trise|danseurs?|danse/i;

interface Spectacle {
  slug?: string;
  link?: string;
  title?: { rendered?: string };
}

export async function scrapeOperaDeRouenNormandie(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const since = effectiveSince(window);
    const today = new Date().toISOString().slice(0, 10);
    for (const spec of await fetchOperaSpectacles(ctx)) {
      const prod = await buildProduction(spec, ctx, since, today);
      if (prod) productions.push(prod);
    }
  } catch (err) {
    console.warn("opera-de-rouen-normandie: spectacle scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opera-de-rouen-normandie: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "opera-de-rouen-normandie", productions };
}

function effectiveSince(window: ScrapeWindow): IsoDate | null {
  if (window.mode === "backfill") return window.since;
  const cutoff = new Date(Date.now() - RECENT_PAST_DAYS * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

/** Every opera-genre `spectacle` (server-side filtered), as discovery rows. */
async function fetchOperaSpectacles(ctx: FetchContext): Promise<Spectacle[]> {
  const rows: Spectacle[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let batch: Spectacle[];
    try {
      batch = await fetchJson<Spectacle[]>(
        `${REST_SPECTACLE}?genre=${OPERA_GENRE_ID}&per_page=${PER_PAGE}&page=${page}&orderby=date&order=desc&_fields=slug,link,title`,
        ctx,
      );
    } catch {
      break; // 400 past the last page
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return rows;
}

async function buildProduction(
  spec: Spectacle,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  const slug = spec.slug ?? slugFromUrl(spec.link ?? "");
  if (!slug || /(?:^|-)(?:opera-)?en-direct(?:-|$)/.test(slug)) return null; // skip cinema broadcasts

  const title = decodeEntities(spec.title?.rendered ?? "").trim();
  if (!title) return null;

  let html: string;
  try {
    html = await fetchHtml(spec.link ?? `${BASE}/programmation/${slug}/`, ctx);
  } catch (err) {
    console.warn(`opera-de-rouen-normandie: detail fetch failed for ${slug}:`, err);
    return null;
  }

  const composer = cleanText(extract(html, /<h2 class="event-title">([\s\S]*?)<\/h2>/) ?? "");
  if (!composer) return null; // opera gate — a real production names its composer

  const performances = parsePerformances(html, since, today);
  if (performances.length === 0) return null;

  const { creative, cast } = parseDistribution(html);

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    premiere_season: seasonOf(performances[0]?.date),
    detail_url: spec.link ?? `${BASE}/programmation/${slug}/`,
    creative_team: creative,
    cast,
    performances,
  };
}

/**
 * Performances from the `<h3 class="short">Venue</h3><p>…</p>` blocks. Each `<br>`
 * line is "Weekday DD month YYYY à HHhMM[ - extra]"; lines that aren't a date
 * (Durée, Tarif) don't match and are skipped. The venue is the block's heading.
 */
function parsePerformances(html: string, since: IsoDate | null, today: string): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const block of html.matchAll(/<h3 class="short">([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)) {
    const venue = cleanText(block[1] ?? "");
    for (const line of (block[2] ?? "").split(/<br\s*\/?>/i)) {
      const m = /(\d{1,2})\s+([a-zà-ÿ]+)\s+(\d{4})\s*à\s*(\d{1,2})\s*h\s*(\d{2})?/i.exec(
        cleanText(line),
      );
      if (!m) continue;
      const mm = MONTHS[(m[2] ?? "").toLowerCase()];
      const date = mm ? isoFromParts(m[3] ?? "", mm, m[1] ?? "") : null;
      if (!date) continue;
      if (since && date < since) continue;
      const time = `${(m[4] ?? "").padStart(2, "0")}:${m[5] ?? "00"}`;
      const key = `${date}|${time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        date,
        time,
        venue_room: venue || null,
        status: date < today ? "past" : "scheduled",
      });
    }
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

interface Distribution {
  creative: RawCredit[];
  cast: RawCredit[];
}

/**
 * Creative team + cast from `<div class="event-distribution">`. Names are each in
 * a `<b>`; the markup before a name is either a `<i>Role</i>` (→ cast) or a plain
 * function label (→ creative). We walk name-by-name, classifying on the preceding
 * chunk since the last name.
 */
function parseDistribution(html: string): Distribution {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const raw = extract(html, /event-distribution[^"]*">([\s\S]*?)<\/div>/);
  if (!raw) return { creative, cast };

  // The WYSIWYG editor fragments names and roles across adjacent tags
  // ("<b>Pierre</b><b> </b><b>Dumoussaud</b>", "<i>Lady</i><i> </i><i>Macbeth</i>")
  // and wraps them in styling `<span>`s; normalize so each name/role is one run.
  const block = raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?span[^>]*>/gi, "")
    .replace(/<(\/?)strong>/gi, "<$1b>")
    .replace(/<\/b>\s*<b>/gi, "")
    .replace(/<\/i>\s*<i>/gi, "");

  // Each <b>Name</b> in order; `before` (lazy) is the text since the previous
  // name — the label or `<i>Role</i>`. (No `</b>` anchor: it would consume the
  // boundary needed to start the next pair and drop every other credit.)
  const seen = new Set<string>();
  for (const m of block.matchAll(/([\s\S]*?)<b>\s*([\s\S]*?)<\/b>/g)) {
    const before = m[1] ?? "";
    const name = cleanText(m[2] ?? "");
    if (!name || ENSEMBLE.test(name)) continue;
    // A cast credit is preceded by a `<i>Role</i>` (take the one nearest the name).
    const roles = [...before.matchAll(/<i>\s*([^<]+?)\s*<\/i>/g)];
    const role = roles.length ? cleanText(roles[roles.length - 1]?.[1] ?? "") : "";
    if (role) {
      if (ENSEMBLE.test(role)) continue;
      const key = `c|${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role, name });
    } else {
      const fn = mapLabel(cleanText(before));
      if (!fn) continue;
      for (const nm of splitNames(name)) {
        const key = `r|${fn}|${nm}`;
        if (seen.has(key)) continue;
        seen.add(key);
        creative.push({ function: fn, name: nm });
      }
    }
  }
  return { creative, cast };
}

function mapLabel(label: string): string | null {
  for (const [re, fn] of CREATIVE_LABELS) if (re.test(label)) return fn;
  return null;
}

function splitNames(raw: string): string[] {
  return raw
    .split(/\s*(?:&|,| et )\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extract(html: string, re: RegExp): string | null {
  return re.exec(html)?.[1] ?? null;
}

function cleanText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/[:–-]\s*$/, "")
    .trim();
}

function seasonOf(date?: IsoDate): string | null {
  if (!date) return null;
  const [y, m] = date.split("-").map(Number) as [number, number];
  const start = m >= 8 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

function slugFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}
