import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
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
 * Theater Vorpommern (`spielplan-html`, server-rendered, no proxy) — plays in
 * Stralsund, Greifswald and Putbus.
 *
 * The sparte filter is an AJAX endpoint: `/de/updateSpielplan?f3=Musiktheater`
 * returns the opera card fragment (the full spielplan page has no per-item sparte
 * marker). Each card links to a `/de/programm/{slug}` detail page: `<h1>` title,
 * a "{genre} von {Composer}" first `lead` `<li>`, `venue-item` blocks
 * (`data-location` venue + a "Wd DD.MM.YYYY / HH:MM Uhr" time), a creative-team
 * `<p>` before the `bes2` heading and a sung-cast `<p>` after it. The Musiktheater
 * sparte also holds a children's opera, a musical and a school project — dropped
 * via a genre blacklist + a required composer. Future-only → Wikidata backfill.
 */

const BASE = "https://www.theater-vorpommern.de";
/** Theater Vorpommern on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q2415981";
/** A staged opera/operetta declares one of these genres in its lead block… */
const OPERA_GENRE = /oper|operette|dramma|singspiel|op[ée]ra|opera|musikdrama/i;
/** …but NOT these (children's opera, musical, plays, dance, concerts, previews). */
const NON_OPERA = /musical|kinderoper|schauspiel|ballett|\btanz|konzert|sicht/i;

export async function scrapeTheaterVorpommern(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const list = await fetchHtml(`${BASE}/de/updateSpielplan?f1=&f2=&f3=Musiktheater&f4=`, ctx);
    const slugs = [...new Set(list.match(/\/de\/programm\/[a-z0-9-]+/g) ?? [])].map((p) =>
      p.replace("/de/programm/", ""),
    );
    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`theater-vorpommern: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("theater-vorpommern: listing failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-vorpommern: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-vorpommern", productions };
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/de/programm/${slug}`;
  const html = await fetchHtml(url, ctx);
  // The whole lead block — the genre/composer may not be in the first <li> (e.g.
  // a musical's "Musik von …" sits below a "nach …" line).
  const lead = stripHtml(html.match(/lead list-unstyled">([\s\S]*?)<\/ul>/)?.[1] ?? "");
  if (!OPERA_GENRE.test(lead) || NON_OPERA.test(`${slug} ${lead}`)) return null;
  const composer = composerFromText(lead);
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!title || !composer) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    creative_team: parseCredits(html, "before"),
    cast: parseCredits(html, "after"),
    performances,
  };
}

/** Each `li.venue-item` carries `data-location` (venue) and one or more
 *  "Wd DD.MM.YYYY / HH:MM Uhr" time rows. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const item of html.split('class="venue-item"').slice(1)) {
    const block = item.split("venue-item")[0] ?? item; // bound to this venue-item
    const venue = stripHtml(item.match(/data-location="([^"]*)"/)?.[1] ?? "") || null;
    for (const t of block.matchAll(
      /class="time">[^<]*?(\d{2})\.(\d{2})\.(\d{4})\s*\/\s*(\d{1,2}:\d{2})/g,
    )) {
      const date = `${t[3]}-${t[2]}-${t[1]}` as IsoDate;
      const time = t[4] ?? null;
      if ((window.since && date < window.since) || seen.has(`${date}|${time}`)) continue;
      seen.add(`${date}|${time}`);
      performances.push({
        date,
        time,
        venue_room: venue,
        status: date < today ? "past" : "scheduled",
      });
    }
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** Creative team is the `<p>` before the `bes2` heading (German function labels),
 *  the sung cast the `<p>` after it (character role + singer); both are
 *  "Label <a href=/de/ensemble/>Name</a>" rows, `<br>`-separated, alternating casts
 *  giving several `<a>` after one label. */
function parseCredits(html: string, side: "before" | "after"): RawCredit[] {
  const idx = html.search(/<h3 data-type="bes2"/);
  if (idx < 0) return [];
  let region: string | undefined;
  if (side === "before") {
    const ps = [...html.slice(0, idx).matchAll(/<p>([\s\S]*?)<\/p>/g)];
    region = ps.at(-1)?.[1]; // the creative <p> sits right before the heading
  } else {
    region = html.slice(idx).match(/<p>([\s\S]*?)<\/p>/)?.[1];
  }

  const out: RawCredit[] = [];
  for (const line of (region ?? "").split(/<br\s*\/?>/)) {
    const label = stripHtml(line.replace(/<a[\s\S]*$/, ""));
    const names = [...line.matchAll(/<a[^>]*\/de\/ensemble\/[^>]*>([\s\S]*?)<\/a>/g)].map((n) =>
      stripHtml(n[1] ?? ""),
    );
    let role = label;
    for (const name of names) {
      if (!name) continue;
      if (side === "after") out.push({ role: role || null, name });
      else {
        const credit = normalizeGermanCredit(role || "", name);
        out.push(credit.function ? credit : { function: role || null, name });
      }
      role = ""; // extra names after the first share the role (alternating cast)
    }
  }
  return out;
}
