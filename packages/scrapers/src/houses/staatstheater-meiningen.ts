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
import { composerFromText, normalizeGermanCredit } from "./_german-credits";

/**
 * Südthüringisches Staatstheater Meiningen / "Das Meininger Theater"
 * (`spielplan-html`, bespoke CMS, no JSON-LD, proxy:true).
 *
 * Canonical host is staatstheater-meiningen.de (das-meininger-theater.de and
 * meininger-staatstheater.de redirect/alias to it); it serves a broken TLS chain
 * to datacenter clients, so fetches route through the proxy.
 *
 * Per-season production index lives at `/premieren/{YYYY-YY}.html` (e.g.
 * `2025-26`, `2026-27`) and links every show as `/produktionen/{slug}.html`.
 * The index isn't genre-tagged, so each detail page is fetched: its first `<p>`
 * after `<h1>` is the work-type line ("Oper in drei Akten von …", "Dramma
 * giocoso … von …", "Tragédie lyrique von …", "Vorabend zum Bühnenfestspiel …
 * von …"). A production is kept only when that line both matches a music-theatre
 * marker AND yields a composer (composerFromText) — this drops Schauspiel,
 * Musical, Ballett, Puppenspiel, concerts and galas.
 *
 * Dates: `ul.performances > li.terminlist`, each with `.day` (DD.MM.YY),
 * `.time` (HH:MM or a HH:MM-HH:MM range), `.location` (venue) and an optional
 * `.red` flag ("Wiederaufnahme" = revival). Creative team is `.regieteam`
 * (German function labels); cast is the `.besetzung` block — both as
 * `<span class="function">Label:</span> <span class="person">Name</span>`.
 * Future/repertoire only → Wikidata backfill.
 */

const BASE = "https://www.staatstheater-meiningen.de";
/** Meininger Staatstheater on Wikidata — verified via wbsearchentities (aliases
 *  include "Südthüringisches Staatstheater Meiningen", "Das Meininger Theater"). */
const WIKIDATA_QID = "Q486132";

/** Work-type markers that flag a sung music-theatre piece on the type line.
 *  Excludes Schauspiel/Musical/Ballett/Puppenspiel/Monolog/Konzert/Revue. */
const MUSIC_THEATRE =
  /\b(oper(ette)?\b|opéra|dramma\s+(giocoso|per\s+musica|lirico)|opera\s+(seria|buffa)|tragéd(ie|ia)\s+(lyrique|en\s+musique)|singspiel|musikdrama|bühnenfestspiel|lyrische?\s+(oper|komödie)|komische\s+oper|spieloper|melodram)/i;

export async function scrapeStaatstheaterMeiningen(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const slugs = new Set<string>();
    for (const season of seasonIndexes()) {
      try {
        const index = await fetchHtml(`${BASE}/premieren/${season}.html`, ctx);
        for (const s of index.matchAll(/produktionen\/([a-z0-9-]+)\.html/gi)) {
          if (s[1]) slugs.add(s[1]);
        }
      } catch (err) {
        console.warn(`staatstheater-meiningen: season ${season} index failed:`, err);
      }
    }

    for (const slug of slugs) {
      try {
        const prod = await buildProduction(ctx, slug, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`staatstheater-meiningen: ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("staatstheater-meiningen: scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("staatstheater-meiningen: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "staatstheater-meiningen", productions };
}

/** Current + next season as "YYYY-YY"; June = season-end, so both are live. */
function seasonIndexes(): string[] {
  const now = new Date();
  const startYear = now.getUTCMonth() + 1 >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return [0, 1].map((d) => {
    const a = startYear + d;
    return `${a}-${String((a + 1) % 100).padStart(2, "0")}`;
  });
}

async function buildProduction(
  ctx: FetchContext,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const url = `${BASE}/produktionen/${slug}.html`;
  const html = await fetchHtml(url, ctx);

  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  // First <p> after the <h1> is the work-type + composer block; its first
  // physical line ("Oper … von {Composer}") carries the genre + composer — keep
  // only that, so the librettist line below the <br> can't bleed into the name.
  const typeBlock = html.match(/<h1[^>]*>[\s\S]*?<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
  const typeLine = stripHtml(typeBlock.split(/<br\s*\/?>/i)[0] ?? "");
  if (!title || !MUSIC_THEATRE.test(typeLine)) return null;

  const composer = composerFromText(typeLine);
  if (!composer) return null;

  const performances = parseTermine(html, window);
  if (performances.length === 0) return null;

  const { cast, creative } = parseCredits(html);
  return {
    source_production_id: slug,
    work_title: title,
    composer_name: composer,
    is_revival: /Wiederaufnahme/i.test(html),
    detail_url: url,
    creative_team: creative,
    cast,
    performances,
  };
}

/** `li.terminlist`: `.day` DD.MM.YY, `.time` HH:MM (or a HH:MM-HH:MM range),
 *  `.location` venue, optional `.red` flag (Wiederaufnahme / Premiere / …). */
function parseTermine(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];

  for (const item of html.split('class="terminlist"').slice(1)) {
    const dm = item.match(/class="day">\s*(\d{2})\.(\d{2})\.(\d{2})\b/);
    if (!dm) continue;
    const date = `20${dm[3]}-${dm[2]}-${dm[1]}` as IsoDate;
    const time = item.match(/class="time">\s*(\d{1,2}:\d{2})/)?.[1] ?? null;
    if ((window.since && date < window.since) || seen.has(`${date}|${time}`)) continue;
    seen.add(`${date}|${time}`);
    performances.push({
      date,
      time,
      venue_room: stripHtml(item.match(/class="location[^"]*">\s*([^<]+)/)?.[1] ?? "") || null,
      ticket_url: item.match(/href="(https:\/\/[^"]*eventim[^"]*)"/)?.[1] ?? null,
      status: date < today ? "past" : "scheduled",
    });
  }
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
  return performances;
}

/** `.regieteam` block = creative team (German labels), `.besetzung` block = sung
 *  cast (role → singer). Both print `<span class="function">Label:</span>
 *  <span class="person">…Name…</span>`; the label distinguishes them. */
function parseCredits(html: string): { cast: RawCredit[]; creative: RawCredit[] } {
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];

  const creativeSeg = sectionAfter(html, "regieteam");
  for (const { label, name } of personRows(creativeSeg)) {
    const credit = normalizeGermanCredit(label, name);
    creative.push(credit.function ? credit : { function: label, name });
  }

  const castSeg = sectionAfter(html, "besetzung");
  for (const { label, name } of personRows(castSeg)) {
    cast.push({ role: label, name });
  }

  return { cast, creative };
}

/** Slice a section's body from its class marker. `.regieteam` carries no heading
 *  and its rows precede the next `<h2>` (Besetzung); `.besetzung` opens with its
 *  own `<h2>Besetzung</h2>`, so drop a leading heading before bounding it at the
 *  next one. Keeps the slice tight without a full DOM parse. */
function sectionAfter(html: string, className: string): string {
  const start = html.indexOf(`${className} `);
  if (start === -1) return "";
  let rest = html.slice(start);
  // .besetzung opens with its own <h2>Besetzung</h2> before any row — drop it so
  // it isn't treated as the section boundary; .regieteam has no heading.
  const firstHeading = rest.search(/<h2[\s>]/);
  const firstRow = rest.search(/class="function"/);
  if (firstHeading !== -1 && (firstRow === -1 || firstHeading < firstRow)) {
    const close = rest.indexOf("</h2>", firstHeading);
    if (close !== -1) rest = rest.slice(close + "</h2>".length);
  }
  const end = rest.search(/<h2[\s>]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Each `<span class="function">Label: </span> … <span class="person">Name</span>`. */
function personRows(seg: string): { label: string; name: string }[] {
  const rows: { label: string; name: string }[] = [];
  for (const m of seg.matchAll(
    /class="function">([\s\S]*?)<\/span>[\s\S]*?class="person">([\s\S]*?)<\/span>/g,
  )) {
    const label = decodeEntities(stripHtml(m[1] ?? ""))
      .replace(/:\s*$/, "")
      .trim();
    const name = stripHtml(m[2] ?? "");
    if (label && name) rows.push({ label, name });
  }
  return rows;
}
