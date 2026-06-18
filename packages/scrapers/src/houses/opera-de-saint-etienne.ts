import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml } from "../fetch";
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
 * Opéra de Saint-Étienne (`spielplan-html` strategy) — opera.saint-etienne.fr
 * (the bare host; `www.` does not resolve). Opixido CMS with stable, walkable
 * URLs: a season's lyric programme is `/otse/saison-YY-YY/spectacles//type-lyrique/`
 * (the `type-lyrique` segment IS the opera gate, vs type-piano/danse/jeune_public),
 * and each production is `…/type-lyrique/<slug>/s-<id>/` with a stable numeric id.
 *
 * Per detail page:
 *   - title: the `<h2 class="misob">…<div>genre</div></h2>` heading (text before
 *     the inner genre div);
 *   - composer: `<div class="sstitre miso">…</div>` (the byline under the title);
 *   - performances: the `<div class="lieu">Venue</div><div class="date">…</div>`
 *     blocks — each `<br>` line is `<span>Weekday DD month </span> : HHh`. The page
 *     omits the YEAR, so it's derived from the season slug (Sep–Dec → start year,
 *     Jan–Aug → end year);
 *   - distribution (`<div id="sd_distribution">`): flat `<span class="bold">X</span>
 *     <br>Name` pairs where X is either a function label (→ creative) or a character
 *     role (→ cast) — disambiguated by whether X maps to a known creative function;
 *     Livret / Orchestre / Chœur / Maîtrise lines are dropped.
 *
 * We cover the previous/current/next season, whose lyric pages link productions
 * as `/otse/saison-YY-YY/…/s-<id>/` (year derivable from the season slug). The
 * deeper archive is linked as `/otse/l-opera/les-saisons-passees/…` whose detail
 * pages omit the year AND the weekday+date doesn't pin it uniquely (e.g. Nov 6/8
 * fall on the same weekdays in 2011/2016/2022), so it's intentionally NOT walked;
 * deep past would come from Wikidata (Q3354530), which currently has no works.
 */

const BASE = "https://opera.saint-etienne.fr";
/** Opéra de Saint-Étienne — verified via wbgetentities: Q3354530, P17 = France. */
const WIKIDATA_QID = "Q3354530";

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
  [/^direction$/i, "chorus-master"], // bare "Direction" only ever follows a Chœur/Maîtrise here
  [/mise\s+en\s+sc[èe]ne/i, "director"],
  [/chor[ée]graph/i, "choreographer"],
  [/lumi[èe]res?|[ée]clairages?/i, "lighting"],
  [/sc[ée]nographie|d[ée]cors?/i, "set-designer"],
  [/costumes?/i, "costume-designer"],
  [/dramaturg/i, "dramaturgy"],
  [/vid[ée]o/i, "video"],
];

/** Bold labels that are work-info, a co/production credit, or an ensemble — never a sung role. */
const DROP_LABEL =
  /^(livret|d['’]après|cr[ée]ation|orchestre|ch(?:œ|oe)ur|ma[îi]trise|ensemble|production|coproduction|nouvelle\s+production|r[ée]alis|cor[ée]al|collaboration|avec\s)/i;
/** A "name" cell that's an institution or work-info, not a person. */
const NON_NAME =
  /d['’]après|cr[ée]ation|^en\s|^les?\s|^l['’]|ateliers|^op[ée]ra\b|orchestre|ch(?:œ|oe)ur/i;
/** A header byline that's a genre descriptor, not the composer. */
const GENRE_LINE =
  /op[ée]ra|comique|com[ée]die|drame|ballet|oratorio|spectacle|concert|\bactes?\b|en\s+\w+\s+(?:actes?|parties?)/i;

export async function scrapeOperaDeSaintEtienne(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const today = new Date().toISOString().slice(0, 10);
    const since = window.mode === "backfill" ? window.since : recentPastFloor();
    const seen = new Set<string>();
    for (const season of seasonsFor(window)) {
      let urls: string[];
      try {
        urls = lyricUrls(
          await fetchHtml(`${BASE}/otse/saison-${season}/spectacles//type-lyrique/`, ctx),
        );
      } catch {
        continue; // a season with no listing page
      }
      for (const path of urls) {
        const id = path.match(/\/s-(\d+)\//)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const prod = await buildProduction(path, id, season, ctx, since, today);
        if (prod) productions.push(prod);
      }
    }
  } catch (err) {
    console.warn("opera-de-saint-etienne: season scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("opera-de-saint-etienne: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "opera-de-saint-etienne", productions };
}

function recentPastFloor(): IsoDate {
  return new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10) as IsoDate;
}

/**
 * The "YY-YY" season slugs to scrape: previous, current, next. (Same in both
 * modes — only these expose lyric productions with a reliably datable year; see
 * the file header on why the deeper archive is left to Wikidata.)
 */
function seasonsFor(_window: ScrapeWindow): string[] {
  const now = new Date();
  const m = now.getUTCMonth() + 1;
  const currentStart = m >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return [currentStart - 1, currentStart, currentStart + 1].map(seasonSlug);
}

function seasonSlug(startYear: number): string {
  return `${String(startYear % 100).padStart(2, "0")}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** Distinct `/…/type-lyrique/<slug>/s-<id>/` production paths in a listing page. */
function lyricUrls(html: string): string[] {
  const set = new Set<string>();
  for (const m of html.matchAll(
    /\/otse\/saison-[0-9-]+\/spectacles\/\/type-lyrique\/[^"/]+\/s-\d+\//g,
  )) {
    set.add(m[0]);
  }
  return [...set];
}

async function buildProduction(
  path: string,
  id: string,
  season: string,
  ctx: FetchContext,
  since: IsoDate | null,
  today: string,
): Promise<RawProduction | null> {
  let html: string;
  try {
    html = await fetchHtml(`${BASE}${path}`, ctx);
  } catch (err) {
    console.warn(`opera-de-saint-etienne: detail fetch failed for ${path}:`, err);
    return null;
  }

  const title = cleanText(extract(html, /<h2 class="misob"[^>]*>\s*([\s\S]*?)\s*<div/) ?? "");
  if (!title) return null;

  // The composer and the "Opéra en N actes" genre swap between the in-title
  // `couleur_2` div and the `sstitre` byline across templates — the composer is
  // whichever isn't a genre descriptor.
  const byline1 = cleanText(
    extract(html, /<h2 class="misob"[^>]*>[\s\S]*?<div class="couleur_2">([\s\S]*?)<\/div>/) ?? "",
  );
  const byline2 = cleanText(extract(html, /<div class="sstitre[^"]*">\s*([^<]+?)\s*<\/div>/) ?? "");
  const composer = [byline1, byline2].find((b) => b && !GENRE_LINE.test(b)) ?? "";
  if (!composer) return null; // opera gate

  const [startYear, endYear] = seasonYears(season);
  const performances = parsePerformances(html, startYear, endYear, since, today);
  if (performances.length === 0) return null;

  const { creative, cast } = parseDistribution(html);

  return {
    source_production_id: `s-${id}`,
    work_title: title,
    composer_name: composer,
    premiere_season: `${startYear}/${String(endYear % 100).padStart(2, "0")}`,
    detail_url: `${BASE}${path}`,
    creative_team: creative,
    cast,
    performances,
  };
}

function seasonYears(season: string): [number, number] {
  const [a, b] = season.split("-");
  return [2000 + Number.parseInt(a ?? "", 10), 2000 + Number.parseInt(b ?? "", 10)];
}

/**
 * Performances from `<div class="lieu">Venue</div><div class="date">…</div>` pairs.
 * Each date line is `<span>Weekday DD month </span> : HHh[MM]`; the year is the
 * season's start year for Sep–Dec, else the end year.
 */
function parsePerformances(
  html: string,
  startYear: number,
  endYear: number,
  since: IsoDate | null,
  today: string,
): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const block of html.matchAll(
    /<div class="lieu">([\s\S]*?)<\/div>\s*<div class="date">([\s\S]*?)<\/div>/g,
  )) {
    const venue = cleanText(block[1] ?? "");
    for (const line of (block[2] ?? "").split(/<br\s*\/?>/i)) {
      const dm =
        /<span>\s*(?:[a-zà-ÿ.]+\s+)?(\d{1,2})\s+([a-zà-ÿ]+)\s*<\/span>\s*:?\s*(\d{1,2})\s*h\s*(\d{2})?/i.exec(
          line,
        );
      if (!dm) continue;
      const mm = MONTHS[(dm[2] ?? "").toLowerCase()];
      if (!mm) continue;
      const year = Number.parseInt(mm, 10) >= 9 ? startYear : endYear;
      const date = isoFromParts(year, mm, dm[1] ?? "");
      if (!date) continue;
      if (since && date < since) continue;
      const time = `${(dm[3] ?? "").padStart(2, "0")}:${dm[4] ?? "00"}`;
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
 * Creative + cast from `<div id="sd_distribution">`: a flat run of
 * `<span class="bold">X</span><br>Name`. Splitting on the bold span pairs each
 * label X with the text up to the next label. X mapping to a creative function →
 * creative; a Livret/ensemble label → dropped; anything else with a person-looking
 * name → a sung character (role X).
 */
function parseDistribution(html: string): Distribution {
  const creative: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const raw = extract(html, /id="sd_distribution"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  if (!raw) return { creative, cast };

  // Bold labels appear as `class="bold"` on some pages and inline
  // `style="font-weight: bold;"` on others, sometimes with the `<br>` inside the
  // span; normalize every bold run to a plain `<b>…</b>` so one split pairs them.
  const block = raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(
      /<span\s+(?:class="bold"|style="[^"]*font-weight:\s*bold[^"]*")\s*>([\s\S]*?)<\/span>/gi,
      "<b>$1</b>",
    )
    .replace(/<(\/?)strong>/gi, "<$1b>");

  const seen = new Set<string>();
  for (const piece of block.split(/<b>/).slice(1)) {
    const end = piece.indexOf("</b>");
    if (end < 0) continue;
    const label = cleanText(piece.slice(0, end));
    const name = cleanText(piece.slice(end + 4));
    if (!label || !name || name.length > 60 || NON_NAME.test(name)) continue;

    const fn = mapLabel(label);
    if (fn) {
      for (const nm of splitNames(name)) {
        const key = `r|${fn}|${nm}`;
        if (seen.has(key)) continue;
        seen.add(key);
        creative.push({ function: fn, name: nm });
      }
    } else if (!DROP_LABEL.test(label) && label.length <= 48) {
      const key = `c|${label}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role: label, name });
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
