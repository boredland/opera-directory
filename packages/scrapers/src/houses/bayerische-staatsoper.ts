import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchJson, fetchRendered, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Bayerische Staatsoper München.
 *
 * staatsoper.de serves a JS-execution challenge and, past it, an "EIN HOFFENTLICH
 * KURZES INTERMEZZO!" bot-fallback to anything that looks headless. A STEALTH
 * headless render (renderHtml masks navigator.webdriver / window.chrome / plugins)
 * gets the real page — verified from both a residential IP and the CI runner. Three
 * data sources, combined:
 *   1. Live spielplan — render /spielplan, parse the `.activity-list__row` entries
 *      (genre filtered to Oper; slug + date + time from the /stuecke/ URL; title +
 *      composer + venue from the row). Cast isn't in the listing.
 *   2. Historical premiere casts (2013/14–2017/18) from the Wikipedia list
 *      "Premierenbesetzungen der Bayerischen Staatsoper ab 2014": a `colspan` title
 *      row ("Work, … Musik von Composer / Composer (Musik), DD. Monat YYYY") + a
 *      4-column Dirigent·Chorleiter | Regie | Sängerinnen | Sänger detail row.
 *   3. Wikidata (P1191) backfill (in backfill mode).
 */

const WIKI_PAGE = "Premierenbesetzungen_der_Bayerischen_Staatsoper_ab_2014";
const WIKI_URL = `https://de.wikipedia.org/wiki/${WIKI_PAGE}`;
// The rendered wiki page stubs non-browser clients (GitHub Actions got an empty
// body); the action API is the bot-supported path and returns the article HTML.
const WIKI_API = `https://de.wikipedia.org/w/api.php?action=parse&page=${WIKI_PAGE}&prop=text&formatversion=2&format=json`;
/** Bayerische Staatsoper on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q681931";

const GERMAN_MONTHS: Record<string, string> = {
  Januar: "01",
  Februar: "02",
  März: "03",
  April: "04",
  Mai: "05",
  Juni: "06",
  Juli: "07",
  August: "08",
  September: "09",
  Oktober: "10",
  November: "11",
  Dezember: "12",
};

export async function scrapeBayerischeStaatsoper(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  // Live spielplan: a stealth render gets the real page (a plain fetch or a
  // non-stealth headless browser is served the "Intermezzo" bot-fallback). fetchRendered
  // uses the proxy's residential stealth Chromium (no browser needed in our CI).
  try {
    const html = await fetchRendered("https://www.staatsoper.de/spielplan", ctx, { waitMs: 6000 });
    if (/INTERMEZZO/i.test(html)) console.warn("bayerische-staatsoper: live got the bot-fallback");
    else productions.push(...parseSpielplan(html, window));
  } catch (err) {
    console.warn("bayerische-staatsoper: live render failed:", err);
  }

  // Historical premiere casts (2013/14–2017/18) from the Wikipedia list.
  try {
    const res = await fetchJson<{ parse?: { text?: string } }>(WIKI_API, ctx);
    productions.push(...parsePremieres(res.parse?.text ?? ""));
  } catch (err) {
    console.warn("bayerische-staatsoper: wikipedia import failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("bayerische-staatsoper: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "bayerische-staatsoper", productions };
}

/**
 * Live spielplan (stealth-rendered): `.activity-list__row` per performance. Each row's
 * `data-schedule-filter` carries the genre `type` (keep "Oper"); the content anchor
 * `/stuecke/{slug}/{YYYY-MM-DD}-{HHMM}-{id}` gives slug + date + time; the row has the
 * title (`<span class="h3">`), composer (first `<p>` in the toggle) and venue
 * ("HH.MM Uhr | Venue"). Grouped by slug. Cast isn't in the listing (would need each
 * detail page) — left to the Wikipedia premieres / future enrichment. Coverage is the
 * rendered window (the list lazy-loads further on scroll).
 */
function parseSpielplan(html: string, window: ScrapeWindow): RawProduction[] {
  const today = new Date().toISOString().slice(0, 10);
  const byslug = new Map<
    string,
    { title: string; composer: string | null; venue: string | null; perfs: RawPerformance[] }
  >();

  for (const row of html.split(/class="activity-list__row"/).slice(1)) {
    const head = row.slice(0, 700);
    if (!/&quot;name&quot;:&quot;Oper&quot;/.test(head)) continue; // genre filter
    const link = row.match(
      /href="\/stuecke\/([a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})-\d+"/,
    );
    if (!link) continue;
    const [, slug, date, hh, mm] = link;
    if (!slug || !date) continue;
    if (window.since && date < window.since) continue;

    let entry = byslug.get(slug);
    if (!entry) {
      entry = {
        title: stripHtml(row.match(/<span class="h3">([\s\S]*?)<\/span>/)?.[1] ?? ""),
        composer: stripHtml(row.match(/toggle__content"><p>([^<]*)</)?.[1] ?? "") || null,
        venue: stripHtml(row.match(/Uhr\s*\|\s*([^<]+)<\/span>/)?.[1] ?? "") || null,
        perfs: [],
      };
      byslug.set(slug, entry);
    }
    entry.perfs.push({
      date: date as IsoDate,
      time: `${hh}:${mm}`,
      venue_room: entry.venue,
      status: date < today ? "past" : "scheduled",
    });
  }

  const out: RawProduction[] = [];
  for (const [slug, e] of byslug) {
    if (!e.title || e.perfs.length === 0) continue;
    const seen = new Set<string>();
    const perfs = e.perfs
      .filter((p) => {
        const k = `${p.date}|${p.time ?? ""}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
    out.push({
      source_production_id: `live/${slug}`,
      work_title: e.title,
      composer_name: e.composer,
      detail_url: `https://www.staatsoper.de/stuecke/${slug}`,
      performances: perfs,
    });
  }
  return out;
}

function parsePremieres(html: string): RawProduction[] {
  // Scan all <tr> rows directly (no per-table match): a colspan row is a production
  // title, the following row its Dirigent/Regie/Sängerinnen/Sänger detail.
  const out: RawProduction[] = [];
  const rows = html.split(/<tr[^>]*>/).slice(1);
  for (let i = 0; i < rows.length; i++) {
    const titleCell = rows[i]?.match(/<td[^>]*\bcolspan="\d+"[^>]*>([\s\S]*?)<\/td>/);
    if (!titleCell?.[1]) continue;
    const prod = buildProduction(titleCell[1], rows[i + 1] ?? "");
    if (prod) out.push(prod);
  }
  return out;
}

function buildProduction(titleHtml: string, detailRow: string): RawProduction | null {
  const workTitle = stripHtml(titleHtml.match(/<b[^>]*><a[^>]*>([^<]+)<\/a>/)?.[1] ?? "");
  const date = parseGermanDate(stripHtml(titleHtml));
  // No `since` filter: this is a fixed, curated historical list (30 premieres), cheap
  // to re-emit on every run; the store merge keeps it idempotent.
  if (!workTitle || !date) return null;

  const cells = [...detailRow.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? "");
  const creative_team = [
    ...parseCreativeCell(cells[0] ?? "", "Musikalische Leitung"),
    ...parseCreativeCell(cells[1] ?? "", "Regie"),
  ];
  const cast = [...parsePersonCell(cells[2] ?? ""), ...parsePersonCell(cells[3] ?? "")].map(
    (p) => ({ role: p.label || null, name: p.name }) satisfies RawCredit,
  );

  const performances: RawPerformance[] = [{ date, status: "past" }];
  return {
    source_production_id: `${date}-${workTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    work_title: workTitle,
    composer_name: parseComposer(stripHtml(titleHtml)),
    premiere_date: date,
    detail_url: WIKI_URL,
    creative_team,
    cast,
    performances,
  };
}

/** Composer appears as "Musik von {Name}", "{Name} (Musik)", or "… von {Librettist}
 *  und {Composer}". Some title lines omit the composer entirely (well-known works) —
 *  then it's null and the cross-house merge fills it from another house's data. */
function parseComposer(title: string): string | null {
  const m =
    title.match(/Musik von\s+([^,(]+?)(?:\s*\(|,|$)/) ??
    title.match(/([A-ZÄÖÜ][^,()]+?)\s*\(Musik\)/) ??
    title.match(/\bvon\s+.+?\s+und\s+([A-ZÄÖÜ][^,(]+?)(?:\s*\(|,|$)/);
  return m?.[1]?.trim() || null;
}

function parseGermanDate(text: string): IsoDate | null {
  const m = text.match(/(\d{1,2})\.\s*([A-Za-zäöü]+)\s*(\d{4})/);
  const month = m ? GERMAN_MONTHS[m[2] ?? ""] : undefined;
  if (!m || !month) return null;
  return isoFromParts(m[3] ?? "", month, m[1] ?? "");
}

/** Singer cell: `<a>Name</a> <small><i>Role</i></small>` per `<br>`. */
function parsePersonCell(cell: string): { name: string; label: string }[] {
  const out: { name: string; label: string }[] = [];
  for (const m of cell.matchAll(/<a[^>]*>([^<]+)<\/a>(?:\s*<small[^>]*><i[^>]*>([^<]*)<\/i>)?/g)) {
    const name = stripHtml(m[1] ?? "");
    if (name) out.push({ name, label: stripHtml(m[2] ?? "") });
  }
  return out;
}

/** Creative cell: a labelled person → that function; the first un-labelled person →
 *  the column default (conductor / director). Ambiguous un-labelled extras are skipped. */
function parseCreativeCell(cell: string, defaultLabel: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  parsePersonCell(cell).forEach((p, idx) => {
    const credit = normalizeGermanCredit(p.label || (idx === 0 ? defaultLabel : ""), p.name);
    if (!credit.function) return; // drop un-labelled non-leading entries (designer order unknown)
    const key = `${credit.function}|${p.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(credit);
  });
  return out;
}
