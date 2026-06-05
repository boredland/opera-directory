import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";

/**
 * Opernhaus Kiel (`spielplan-html`).
 *
 * Listing-only: the spielplan AJAX `/spielplan/spielplan.html?ajax=1&offset={n}`
 * returns one month of server-rendered performance rows per offset (walk until the
 * body is "ende erreicht."). Each opera row's class carries `sparte-4` (Oper),
 * `produktion-{id}` and `date-{DDMMYY}`; the row has a genre label
 * (`<div class="fw-bold">Oper</div>`), the title + slug (`<a href="./produktionen/
 * {slug}.html">`), and "{venue} | HH.MM Uhr". `sparte-4` is over-broad (it also
 * tags tours/café/chamber concerts), so we keep only rows whose label is exactly
 * Oper/Operette and drop non-work titles + the musicals/revue Kiel files under the
 * same sparte (no composer to filter them structurally). **Composer & cast are NOT obtainable**:
 * the detail pages 301 to the homepage for every non-interactive client (even the
 * proxy's stealth render lands on the homepage — the block is a session-bound
 * server redirect, not JS), so the work's composer comes from the cross-house
 * merge / Wikidata backfill, and cast is unavailable. Future/season → Wikidata.
 */

const BASE = "https://theater-kiel.de";
/** Opernhaus Kiel on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q737243";
const MAX_MONTHS = 15;
/** sparte-4 also tags these non-staged "Oper" formats — drop by title. */
const NON_WORK = /führung|operncafé|opern-café|streichquartett|lounge|einführung|matinee/i;
/**
 * Kiel files musicals & revue under the same "Oper" sparte as opera, and with no
 * composer in the listing they can't be filtered structurally — so the obvious
 * non-opera titles are denylisted by hand (revisit each season).
 */
const NON_OPERA = /west side story|la cage aux folles|melodien für millionen/i;

export async function scrapeTheaterKiel(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    productions.push(...(await walkSpielplan(ctx, window)));
  } catch (err) {
    console.warn("theater-kiel: spielplan failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("theater-kiel: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "theater-kiel", productions };
}

async function walkSpielplan(ctx: FetchContext, window: ScrapeWindow): Promise<RawProduction[]> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, { title: string; perfs: RawPerformance[] }>();

  for (let offset = 0; offset < MAX_MONTHS; offset++) {
    const html = await fetchHtml(`${BASE}/spielplan/spielplan.html?ajax=1&offset=${offset}`, ctx);
    if (/ende erreicht/.test(html)) break;
    for (const row of html.split('<div id="ID_Vorstellung_').slice(1)) {
      addRow(bySlug, row, window, today);
    }
  }

  const out: RawProduction[] = [];
  for (const [slug, p] of bySlug) {
    if (!p.title || p.perfs.length === 0) continue;
    out.push({
      source_production_id: slug,
      work_title: p.title,
      detail_url: `${BASE}/spielplan/produktionen/${slug}.html`,
      performances: p.perfs.sort(
        (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
      ),
    });
  }
  return out;
}

function addRow(
  bySlug: Map<string, { title: string; perfs: RawPerformance[] }>,
  row: string,
  window: ScrapeWindow,
  today: string,
): void {
  const cls = row.slice(0, row.indexOf(">"));
  if (!/\bsparte-4\b/.test(cls)) return; // not opera-sparte
  const dmy = cls.match(/\bdate-(\d{2})(\d{2})(\d{2})\b/);
  if (!dmy) return;
  // The genre label (col-2) precedes the title link; keep only real Oper/Operette.
  const m = row.match(
    /fw-bold">\s*(Oper|Operette)\s*<\/div>\s*<div class="fs-4 heading fw-bold"><a href="\.\/produktionen\/([a-z0-9-]+)\.html[^>]*>([\s\S]*?)<\/a>/,
  );
  if (!m) return;
  const slug = m[2];
  const title = stripHtml(m[3] ?? "");
  if (!slug || !title || NON_WORK.test(title) || NON_OPERA.test(title)) return;

  const date = `20${dmy[3]}-${dmy[2]}-${dmy[1]}` as IsoDate;
  if (window.since && date < window.since) return;
  // "<span>{venue}</span> | {start}[–{end}]&nbsp;Uhr" — grab venue + start time
  // (the "Uhr" suffix is an HTML entity, so don't anchor on it).
  const vt = row.match(/<span>([^<]+)<\/span>\s*\|\s*(\d{1,2})\.(\d{2})/);
  const time = vt ? `${vt[2]?.padStart(2, "0")}:${vt[3]}` : null;

  const entry = bySlug.get(slug) ?? { title, perfs: [] };
  if (!entry.perfs.some((p) => p.date === date && p.time === time)) {
    entry.perfs.push({
      date,
      time,
      venue_room: stripHtml(vt?.[1] ?? "") || null,
      status: date < today ? "past" : "scheduled",
    });
  }
  bySlug.set(slug, entry);
}
