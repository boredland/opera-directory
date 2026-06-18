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
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Landestheater Niederbayern (`spielplan-html`, WordPress + the "shmtheme"
 * theatre theme, server-rendered, no usable JSON-LD).
 *
 * A touring state theatre playing Landshut / Passau / Straubing (+ Bad Birnbach,
 * Deggendorf, Osterhofen, Regensburg). The /spielplan/ page is one big
 * server-rendered listing split into sparte sections by an `<h2 id="…">`; the
 * Oper & Operette section (`id="oper-operette"`) links every music-theatre show
 * as /event/{slug}/. The genre/sparte grouping is the filter — but each detail
 * page is still gated on `composerFromText` to drop anything non-work.
 *
 * Detail page: `<h1>` title, `p.shmtheme_content__post_untertitel` work-type line
 * ("Dramma giocoso von … / Operette von … / Bühnenweihfestspiel von …"), a
 * `.shmtheme_single_event__kreativteam` block of `__member__function` label +
 * `__member__name` (German labels → creative team), and a `.shmtheme_person_teaser`
 * carousel of singers (`__title` name + `__tatigkeiten` role). The carousel is
 * rendered twice (desktop + mobile slider), so cast is deduped.
 *
 * Dates: the live `.shmtheme_single_event__termine` form groups
 * `.shmtheme_single_termin` blocks under a `__termine__header` date ("Freitag,
 * 12. Juni 2026"); each termin carries a `.location` ("Passau - Stadttheater"),
 * a `.time` ("19:30 Uhr") and `data-cancelled`. This form lists only UPCOMING
 * nights, so already-played productions have an empty form — for those we fall
 * back to the per-city premiere dates in the `.zusatzinfos` "Premiere" block
 * ("Landshut, 02.04.2026"), so this-season's past shows still emit dated rows.
 * Future/repertoire only → Wikidata backfill.
 */

const BASE = "https://www.landestheater-niederbayern.de";
/** Landestheater Niederbayern on Wikidata — verified via wbsearchentities +
 *  EntityData: de description "Theater in mehreren niederbayerischen Städten",
 *  P31 = theatre (Q742421) + Landestheater (Q20819922). */
const WIKIDATA_QID = "Q1802667";

const GERMAN_MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  märz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

export async function scrapeLandestheaterNiederbayern(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const index = await fetchHtml(`${BASE}/spielplan/`, ctx);
    for (const slug of operaSlugs(index)) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`landestheater-niederbayern: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("landestheater-niederbayern: index failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("landestheater-niederbayern: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "landestheater-niederbayern", productions };
}

/** /event/{slug} links inside the `id="oper-operette"` section, bounded by the
 *  next sparte `<h2 id="…">`. The sparte grouping is the music-theatre filter. */
function operaSlugs(html: string): string[] {
  const start = html.indexOf('id="oper-operette"');
  if (start === -1) return [];
  const rest = html.slice(start);
  const end = rest.slice(1).search(/<h2[^>]+id="[a-z-]+"/);
  const section = end === -1 ? rest : rest.slice(0, end + 1);
  const slugs = new Set<string>();
  for (const [, slug] of section.matchAll(/\/event\/([a-z0-9-]+)\//g)) {
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/event/${slug}/`;
  const html = await fetchHtml(url, ctx);

  const title = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const typeLine = clean(
    html.match(/class="shmtheme_content__post_untertitel"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "",
  );
  const composer = composerFromText(typeLine);
  if (!title || !composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseCredits(html);
  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    presentation_note: typeLine || null,
    detail_url: url,
    image_url: html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null,
    creative_team: creative,
    cast,
    performances,
  };
}

/** Live `.shmtheme_single_termin` rows grouped under date headers; falls back to
 *  the per-city premiere dates when the live form is empty (already-played show). */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  const form =
    html.match(/class="shmtheme_single_event__termine"([\s\S]*?)<\/form>/)?.[1] ??
    html.slice(html.indexOf("shmtheme_single_event__termine"));

  // Each date header owns every termin until the next header.
  for (const group of form.split(/class="shmtheme_single_event__termine__header"/).slice(1)) {
    const date = parseGermanDate(clean(group.match(/>([\s\S]*?)<\/span>/)?.[1] ?? ""));
    if (!date) continue;
    for (const termin of group.split(/class="shmtheme_single_termin /).slice(1)) {
      const cancelled = /data-cancelled="[^"]+"/.test(termin.slice(0, 200));
      const time =
        termin.match(
          /class="shmtheme_single_termin_info time"[\s\S]*?<span>\s*(\d{1,2}:\d{2})/,
        )?.[1] ?? null;
      const venue =
        clean(
          termin.match(
            /class="shmtheme_single_termin_info location"[\s\S]*?<span>([\s\S]*?)<\/span>/,
          )?.[1] ?? "",
        ) || null;
      const key = `${date}|${time}|${venue}`;
      if ((window.since && date < window.since) || seen.has(key)) continue;
      seen.add(key);
      performances.push({
        date,
        time,
        venue_room: venue,
        status: cancelled ? "cancelled" : date < today ? "past" : "scheduled",
      });
    }
  }

  if (performances.length === 0) {
    for (const p of parsePremiereDates(html, window, today)) {
      const key = `${p.date}|${p.time}|${p.venue_room}`;
      if (seen.has(key)) continue;
      seen.add(key);
      performances.push(p);
    }
  }

  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** `.zusatzinfos` "Premiere" block — `<div>{Town}, DD.MM.YYYY</div>` per city. */
function parsePremiereDates(html: string, window: ScrapeWindow, today: string): RawPerformance[] {
  const block = html.match(
    /class="shmtheme_single_event__zusatzinfos__title">\s*Premiere\s*<\/div>\s*<div class="shmtheme_single_event__zusatzinfos__value">([\s\S]*?)<\/div>\s*<\/div>/,
  )?.[1];
  if (!block) return [];
  const rows: RawPerformance[] = [];
  for (const [, town, d, mo, y] of block.matchAll(
    /<div>\s*([^,<]+?),\s*(\d{2})\.(\d{2})\.(\d{4})\s*<\/div>/g,
  )) {
    const date = isoFromParts(y ?? "", mo ?? "", d ?? "");
    if (!date) continue;
    if (window.since && date < window.since) continue;
    rows.push({
      date,
      time: null,
      venue_room: clean(town ?? "") || null,
      status: date < today ? "past" : "scheduled",
    });
  }
  return rows;
}

/** "Freitag, 12. Juni 2026" → ISO. */
function parseGermanDate(text: string): IsoDate | null {
  const m = text.match(/(\d{1,2})\.\s*([A-Za-zäöü]+)\s+(\d{4})/);
  if (!m) return null;
  const month = GERMAN_MONTHS[(m[2] ?? "").toLowerCase()];
  if (!month) return null;
  return isoFromParts(m[3] ?? "", month, m[1] ?? "");
}

/** `.kreativteam` block = creative team (German function labels → mapped credit);
 *  `.person_teaser` carousel = sung cast (role → singer), rendered twice → deduped. */
function parseCredits(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const creative: RawCredit[] = [];
  for (const [, label, name] of html.matchAll(
    /class="shmtheme_single_event__kreativteam__member__function">([\s\S]*?)<\/span>\s*<a[^>]*class="shmtheme_single_event__kreativteam__member__name"[^>]*>([\s\S]*?)<\/a>/g,
  )) {
    const fn = clean(label ?? "");
    const person = clean(name ?? "");
    if (!fn || !person) continue;
    const credit = normalizeGermanCredit(fn, person);
    creative.push(credit.function ? credit : { function: fn, name: person });
  }

  const cast: RawCredit[] = [];
  const seenCast = new Set<string>();
  for (const [, name, role] of html.matchAll(
    /class="shmtheme_person_teaser__title">([\s\S]*?)<\/div>[\s\S]*?class="shmtheme_person_tatigkeiten">([\s\S]*?)<\/div>/g,
  )) {
    const person = clean(name ?? "");
    const part = clean(role ?? "");
    if (!person || !part) continue;
    const key = `${part}|${person}`;
    if (seenCast.has(key)) continue;
    seenCast.add(key);
    cast.push({ role: part, name: person });
  }

  return { cast, creative };
}

/** Strip tags + decode entities + drop soft hyphens. */
function clean(s: string): string {
  return decodeEntities(stripHtml(s)).replace(/­/g, "").trim();
}
