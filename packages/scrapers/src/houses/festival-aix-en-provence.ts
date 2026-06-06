import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, proxyFetch, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Festival d'Aix-en-Provence (`render`-shaped `spielplan-html` strategy) — the
 * major French summer opera festival (~July). A FESTIVAL: one edition at a time,
 * empty off-season, so the live scrape is the CURRENT edition's staged opera;
 * `backfill` appends Wikidata for past editions.
 *
 * festival-aix.com is a Next.js (App Router) site with NO schema.org Event
 * JSON-LD and NO __NEXT_DATA__ — the data rides in the RSC flight payload
 * (`self.__next_f.push([1,"…"])` chunks). We reassemble those chunks into one
 * string and parse the embedded JSON fragments directly (no JS eval). Two data
 * sources sit in that payload:
 *   - a Secutix ticketing product object — `{"fr":TITLE},"description":[],
 *     "productType":"EVENT"` for the work title, `subtitle.fr` for the composer
 *     ("{FRENCH TITLE} — {COMPOSER}", or just "{COMPOSER}"), and a structured
 *     `performances[]` array (UTC-stamped `start`, `venue.fr`) — the reliable,
 *     on-sale date list.
 *   - Drupal `cast_item` paragraphs — `{"field_cast_item":NAME,"field_title":
 *     LABEL}` pairs carrying both the creative team and the sung cast. The /en
 *     page embeds BOTH the French and English label blocks (each paragraph tagged
 *     `langcode`); we keep only the FRENCH paragraphs and map their labels.
 *
 * FILTERING to staged opera: the `/programmation/opera/` URL space already
 * separates opera from `/concert/`, but it still carries concert versions
 * (Bartók's Bluebeard "version de concert", a concert Vêpres siciliennes). The
 * opera filter mirrors the other festival adapters: REQUIRE a composer AND a
 * staging credit (Mise en scène → director). A concert version carries no
 * director and is dropped.
 *
 * Times are stored in the Secutix feed as a Z-suffixed LOCAL wall-clock (the
 * Archevêché's late open-air 21:30 start is stored "21:30:00.000Z"), so the
 * date + HH:MM are read straight off the ISO string, not timezone-converted.
 *
 * The Next.js routes answer 200 with content even when middleware tags them 404
 * (locale rewrite quirk), so we fetch tolerantly rather than via fetchHtml
 * (which throws on non-200).
 */

const BASE = "https://festival-aix.com";
/** Aix-en-Provence Festival on Wikidata — verified via wbsearchentities
 *  (Q1408668, "Aix-en-Provence Festival", alias "Festival d'Aix-en-Provence",
 *  "annual international music festival"). Carries P4647 premieres and P272
 *  productions with composer (P86) + first-performance date for backfill. */
const WIKIDATA_QID = "Q1408668";

/** French creative-team labels → canonical function keys. The /en page also emits
 *  the English labels; those collapse onto the same functions via dedup. Any label
 *  not mapped here and not flagged as production-crew noise is treated as a sung
 *  role. */
const CREDIT_LABELS: Record<string, string> = {
  "direction musicale": "conductor",
  "supervision musicale": "conductor",
  "mise en scène": "director",
  "mise en scène et vidéo": "director",
  "mise en scène et scénographie": "director",
  scénographie: "set-designer",
  décors: "set-designer",
  "décors et costumes": "set-designer",
  costumes: "costume-designer",
  lumière: "lighting",
  lumières: "lighting",
  éclairages: "lighting",
  chorégraphie: "choreographer",
  dramaturgie: "dramaturgy",
  "chef de chœur": "chorus-master",
  "chef de choeur": "chorus-master",
  "direction des chœurs": "chorus-master",
  "direction des choeurs": "chorus-master",
  vidéo: "video-designer",
  son: "sound-designer",
};

/** Production-crew labels that are neither a lead creative function nor a sung
 *  character — assistants, coaches, extras. Dropped so they don't pollute cast. */
const CREW_NOISE =
  /assistant|assistante|répétit|repetit|chef de chant|collaborat|figurant|comédien|comedien|supervision|membres du|chorakademie|orchestre|orchestra|chœur de|choeur de|choir$|^chœur$|^choeur$/i;

export async function scrapeFestivalAixEnProvence(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const slugs = await collectOperaSlugs(ctx);
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`festival-aix-en-provence: opera ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("festival-aix-en-provence: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("festival-aix-en-provence: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "festival-aix-en-provence", productions };
}

/** The /en homepage lists every opera of the current edition as
 *  `/en/programmation/opera/{slug}` links (the `/concert/` space is separate). */
async function collectOperaSlugs(ctx: FetchContext): Promise<string[]> {
  const html = await fetchTolerant(`${BASE}/en`, ctx);
  const slugs = new Set<string>();
  for (const [, slug] of html.matchAll(/href="\/en\/programmation\/opera\/([^"#?]+)"/g)) {
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/en/programmation/opera/${slug}`;
  const html = await fetchTolerant(detailUrl, ctx);
  const flight = reassembleFlight(html);

  const composer = parseComposer(flight);
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(flight);
  // A staged opera always credits a director; concert versions don't. This is the
  // opera filter that drops "version de concert" billings the URL space lets through.
  if (!creative_team.some((c) => c.function === "director")) return null;

  const performances = parsePerformances(flight, window);
  if (performances.length === 0) return null;

  const title = parseTitle(flight, html);
  if (!title) return null;

  return {
    source_production_id: `aix/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: detailUrl,
    image_url: parseImage(flight),
    creative_team,
    cast,
    performances,
  };
}

/** Concatenate the RSC flight chunks into one decoded string. Each chunk is a
 *  JSON-string-escaped slice of the streamed payload; JSON.parse un-escapes it. */
function reassembleFlight(html: string): string {
  let buf = "";
  for (const [, chunk] of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try {
      buf += JSON.parse(`"${chunk}"`);
    } catch {
      // a chunk that isn't a plain string (rare control frame) — skip it
    }
  }
  return buf;
}

/** The ticketing `subtitle.fr` reads "{FRENCH TITLE} — {COMPOSER}" or just
 *  "{COMPOSER}". The composer is the last em-dash/hyphen segment, ignoring a
 *  "version de concert" qualifier segment. */
function parseComposer(flight: string): string | null {
  const m = flight.match(/"subtitle":\{"fr":"((?:[^"\\]|\\.)*)"\}/);
  if (!m?.[1]) return null;
  const subtitle = decodeEntities(JSON.parse(`"${m[1]}"`));
  const parts = subtitle
    .split(/\s+[—–-]\s+/)
    .map((p) => p.trim())
    .filter((p) => p && !/version de concert|concert/i.test(p));
  const composer = parts[parts.length - 1]?.trim() ?? "";
  return composer.length >= 3 ? composer : null;
}

/** Work title from the Secutix product object, falling back to the page <title>. */
function parseTitle(flight: string, html: string): string | null {
  const m = flight.match(/\{"fr":"((?:[^"\\]|\\.)*)"\},"description":\[\],"productType":"EVENT"/);
  if (m?.[1]) {
    const t = decodeEntities(JSON.parse(`"${m[1]}"`)).trim();
    if (t) return t;
  }
  const head = html.match(/<title>([^<|]+)/)?.[1]?.trim();
  return head || null;
}

function parseImage(flight: string): string | null {
  const m = flight.match(/"image":\{"small":"((?:[^"\\]|\\.)*)"/);
  return m?.[1] ? JSON.parse(`"${m[1]}"`) : null;
}

/** Drupal `cast_item` pairs → creative team (mapped French labels) + sung cast.
 *  Each paragraph is tagged `langcode`; we keep only the FRENCH ones (the /en page
 *  duplicates every credit in an English paragraph too). `langcode` sits a few
 *  hundred chars ahead of the fields in the same paragraph. */
function parseCredits(flight: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  for (const [, lang, rawName, rawLabel] of flight.matchAll(
    /"langcode":"(fr|en)"[\s\S]{0,400}?"field_cast_item":"((?:[^"\\]|\\.)*)","field_title":"((?:[^"\\]|\\.)*)"/g,
  )) {
    if (lang !== "fr") continue;
    const label = decodeEntities(JSON.parse(`"${rawLabel ?? ""}"`)).trim();
    if (!label) continue;

    const fn = CREDIT_LABELS[label.toLowerCase().replace(/:\s*$/, "")];
    for (const name of splitNames(rawName ?? "")) {
      if (fn) {
        const key = `${fn}|${name}`;
        if (seenCreative.has(key)) continue;
        seenCreative.add(key);
        creative_team.push({ function: fn, name });
      } else {
        // Unmapped label: a sung character role, unless it's crew noise
        // (assistants, coaches, ensembles) we don't surface as cast.
        if (CREW_NOISE.test(label)) continue;
        const key = `${label}|${name}`;
        if (seenCast.has(key)) continue;
        seenCast.add(key);
        cast.push({ role: label, name });
      }
    }
  }

  return { creative_team, cast };
}

/** A `field_cast_item` may list several names (co-credits / ensembles separated
 *  by " et "); split, strip the alternate-cast asterisk, drop empties. */
function splitNames(raw: string): string[] {
  const decoded = decodeEntities(JSON.parse(`"${raw}"`));
  return decoded
    .split(/\s+et\s+|,(?![^(]*\))/)
    .map((n) =>
      stripHtml(n)
        .replace(/[*‡†§]+\s*$/, "")
        .trim(),
    )
    .filter((n) => n.length >= 2 && n.length <= 80);
}

/** Each Secutix `performances[]` entry is one dated showing. `start` is a
 *  Z-suffixed local wall-clock — read the date + HH:MM straight off the string. */
function parsePerformances(flight: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const [, perfBlock] of flight.matchAll(/"performanceId":\d+,([\s\S]*?)"maxAllowedSeats"/g)) {
    if (!perfBlock) continue;
    const startRaw = perfBlock.match(/"start":"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (!startRaw) continue;
    const date = startRaw[1] as IsoDate;
    if (window.since && date < window.since) continue;

    const time = startRaw[2] ?? null;
    const venueRaw = perfBlock.match(/"venue":\{"fr":"((?:[^"\\]|\\.)*)"\}/)?.[1];
    const venue = venueRaw ? decodeEntities(JSON.parse(`"${venueRaw}"`)) : null;

    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, venue_room: venue, status: date < today ? "past" : "scheduled" });
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Fetch tolerating the Next.js 404-with-content quirk (so we can't use
 *  fetchHtml, which throws on non-200). */
async function fetchTolerant(url: string, ctx: FetchContext): Promise<string> {
  const res = await proxyFetch(url, ctx.proxy, {
    headers: { "User-Agent": ctx.userAgent, "Accept-Language": "en,fr;q=0.8" },
    signal: AbortSignal.timeout(30000),
  });
  return res.text();
}
