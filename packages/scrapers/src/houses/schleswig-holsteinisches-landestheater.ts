import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchRendered, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Schleswig-Holsteinisches Landestheater und Sinfonieorchester (`render`,
 * Stagenet CMS) — Germany's largest touring theatre, seated in Rendsburg and
 * playing Flensburg, Schleswig, Heide, Husum and a string of guest venues.
 *
 * The spielplan (/spielplan/index.html) is a single client-rendered list of every
 * dated performance for the announced seasons; the bundled `spielplanfilter.js`
 * only shows/hides rows by CSS classes (`sparte-37` = Musiktheater, `ort-NN` =
 * town, `date-DDMMYY`), so a headless render of that one page yields the whole
 * future at once — routed through the proxy's stealth render (`proxy: true`),
 * since a plain fetch returns the empty shell. Each row carries the production
 * slug, town, start time and the displayed title; we keep only `sparte-37` rows
 * and group them by slug.
 *
 * Per-production composer + creative team + cast come from the *static*
 * /produktionen/{slug}.html page (a plain fetch — the spielplan's `./produktionen/`
 * links resolve against the page's site-root `<base href>`). The genre/composer
 * descriptor ("Oper in drei Akten von Francis Poulenc") sits in a text node; credit
 * rows are `<span class="fw-bold">Label:</span> … <a title="Name">`. A row whose
 * label maps in the German credit map is creative, anything else a sung role.
 * Requiring a composer drops the concerts/galas/junges-theater that also tag
 * Musiktheater. Future-only source → Wikidata supplies the deep-past backfill.
 */

const BASE = "https://www.sh-landestheater.de";
const SPIELPLAN_URL = `${BASE}/spielplan/index.html`;
/** Schleswig-Holsteinisches Landestheater on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q776404";
/** The Musiktheater sparte (opera/operetta) in the spielplan filter classes. */
const MUSIKTHEATER_SPARTE = "37";

/** ort-NN class → town, from the spielplan's Orte filter. */
const ORTE: Record<string, string> = {
  "55": "Flensburg",
  "58": "Rendsburg",
  "60": "Schleswig",
  "56": "Heide",
  "57": "Husum",
  "37": "Itzehoe",
  "8": "Meldorf",
  "49": "Neumünster",
  "68": "Niebüll",
  "66": "St. Peter-Ording",
  "38": "Mobil unterwegs",
  "62": "Gastspielorte",
};

export async function scrapeSchleswigHolsteinischesLandestheater(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const html = await fetchRendered(SPIELPLAN_URL, ctx, { waitMs: 8000 });
    const bySlug = groupPerformances(html, window);
    for (const [slug, performances] of bySlug) {
      try {
        const prod = await buildProduction(ctx, slug, performances);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`sh-landestheater: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("sh-landestheater: spielplan render failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("sh-landestheater: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "schleswig-holsteinisches-landestheater", productions };
}

interface SpielplanRow {
  title: string;
  performance: RawPerformance;
}

/** Split the rendered spielplan into Musiktheater performance rows, keyed by
 *  production slug. `date-DDMMYY` (getYear()-based YY → 20YY), `ort-NN` → town,
 *  `HH.MM–…Uhr` → start time. */
function groupPerformances(html: string, window: ScrapeWindow): Map<string, SpielplanRow[]> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, SpielplanRow[]>();

  for (const block of html.split('<div id="ID_Vorstellung_').slice(1)) {
    const classes = block.match(/^\d+"\s+class="([^"]*)"/)?.[1] ?? "";
    if (!classes.split(/\s+/).includes(`sparte-${MUSIKTHEATER_SPARTE}`)) continue;

    const date = parseDate(classes.match(/\bdate-(\d{6})\b/)?.[1]);
    if (!date) continue;
    if (window.since && date < window.since) continue;

    const slug = block.match(/produktionen\/([a-z0-9-]+)\.html/)?.[1];
    if (!slug) continue;

    const title = clean(
      block.match(/class="text-uppercase fw-bold[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "",
    );
    const ortClass = classes.match(/\bort-(\d+)\b/)?.[1];
    const venue = ortClass ? (ORTE[ortClass] ?? null) : null;
    const time =
      block
        .match(/(\d{1,2})\.(\d{2})\s*[–-]/)
        ?.slice(1, 3)
        .join(":") ?? null;

    const row: SpielplanRow = {
      title,
      performance: {
        date,
        time,
        venue_room: venue,
        status: date < today ? "past" : "scheduled",
      },
    };
    const rows = bySlug.get(slug);
    if (rows) rows.push(row);
    else bySlug.set(slug, [row]);
  }
  return bySlug;
}

/** Stagenet `date-DDMMYY` uses Date.getYear() (year − 1900), so YY is the 2-digit
 *  year offset; 26 → 2026, 27 → 2027. */
function parseDate(ddmmyy: string | undefined): IsoDate | null {
  if (!ddmmyy) return null;
  const day = ddmmyy.slice(0, 2);
  const month = ddmmyy.slice(2, 4);
  const year = 2000 + Number.parseInt(ddmmyy.slice(4, 6), 10);
  return `${year}-${month}-${day}` as IsoDate;
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  rows: SpielplanRow[],
): Promise<RawProduction | null> {
  const url = `${BASE}/produktionen/${slug}.html`;
  const html = await fetchHtml(url, ctx);

  const genre = genreLine(html);
  // Musicals also tag Musiktheater; drop them (and revues/concerts have no genre line).
  if (!genre || /\bMusical\b/i.test(genre)) return null;
  const composer = composerFromText(genre);
  if (!composer) return null;

  const title = clean(html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? "");
  if (!title) return null;

  const { cast, creative } = parseCredits(html);

  const performances = dedupePerformances(rows.map((r) => r.performance));
  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** The genre/composer descriptor — a short text node carrying a genre word and
 *  "von {Composer}" ("Oper in drei Akten von Francis Poulenc"). */
function genreLine(html: string): string | null {
  for (const m of html.matchAll(/>([^<>]{6,120}?\bvon\b[^<>]{3,60}?)</g)) {
    const t = clean(m[1] ?? "");
    if (/Landestheater/.test(t)) continue;
    if (/\b(Oper|Operette|Op[eé]ra|Musical|Singspiel)\b/i.test(t)) return t;
  }
  return null;
}

/** `<span class="fw-bold">Label:</span> <span> <a title="Name"> …`. Labels in the
 *  German credit map are creative functions, anything else a sung role. */
function parseCredits(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<span class="fw-bold">([^<]+?):?<\/span>\s*<span>\s*<a title="([^"]+)"/g,
  )) {
    const label = clean(m[1] ?? "");
    const name = clean(m[2] ?? "");
    if (!label || !name) continue;
    const key = `${label}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative.push(credit);
    else cast.push({ role: label, name });
  }
  return { cast, creative };
}

function dedupePerformances(performances: RawPerformance[]): RawPerformance[] {
  const seen = new Set<string>();
  const out: RawPerformance[] = [];
  for (const p of performances) {
    const key = `${p.date}T${p.time ?? ""}@${p.venue_room ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  return out;
}

/** Named HTML entities for the Slavic háček letters that the shared decoder in
 *  fetch.ts doesn't carry — Czech composer names ("Leo&scaron; Jan&aacute;ček")
 *  would otherwise be truncated at the `;` by composerFromText. */
const EXTRA_ENTITIES: Record<string, string> = {
  "&scaron;": "š",
  "&Scaron;": "Š",
  "&zcaron;": "ž",
  "&Zcaron;": "Ž",
  "&ccaron;": "č",
  "&Ccaron;": "Č",
  "&rcaron;": "ř",
  "&Rcaron;": "Ř",
};

/** Strip tags + soft hyphens (titles use U+00AD), decode entities. */
function clean(s: string): string {
  const repaired = s.replace(/&[A-Za-z]+;/g, (m) => EXTRA_ENTITIES[m] ?? m);
  return decodeEntities(stripHtml(repaired)).replace(/­/g, "").trim();
}
