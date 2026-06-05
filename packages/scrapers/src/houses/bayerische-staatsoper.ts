import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { normalizeGermanCredit } from "./_german-credits";

/**
 * Bayerische Staatsoper München.
 *
 * The live site staatsoper.de is a Cloudflare-challenged JS SPA — not reachable
 * by a plain crawler. The historical premiere casts, however, are maintained on
 * Wikipedia ("Premierenbesetzungen der Bayerischen Staatsoper ab 2014", covering
 * the 2013/14–2017/18 seasons). We import them: each premiere is a `colspan` title
 * row ("Work, … Musik von Composer / Composer (Musik), DD. Monat YYYY") followed by
 * a 4-column detail row (Dirigent·Chorleiter | Regie·Ausstattung·Licht |
 * Sängerinnen | Sänger), where each person is `<a>Name</a> <small><i>Role</i></small>`.
 * Wikidata (P1191) backfills further premieres. Live spielplan TODO (needs a
 * Cloudflare-solving fetch path).
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
  await reconLiveViaProxy();

  const productions: RawProduction[] = [];
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

/** TEMPORARY recon: probe the Cloudflare-protected live spielplan through the
 *  FETCH_PROXY (FlareSolverr) and log its shape so the live adapter can be written.
 *  Builds the proxy from env directly so the Wikipedia fetch above stays un-proxied. */
async function reconLiveViaProxy(): Promise<void> {
  const url = process.env.FETCH_PROXY_URL;
  if (!url) {
    console.warn("münchen-recon: no FETCH_PROXY_URL (skipping live probe)");
    return;
  }
  // &solve=1 forces the proxy's FlareSolverr path (München's challenge isn't a
  // small CF page, so the proxy's auto-detect doesn't fire).
  const target = "https://www.staatsoper.de/spielplan";
  const proxyUrl = `${url}?url=${encodeURIComponent(target)}&solve=1`;
  const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0" };
  if (process.env.FETCH_PROXY_TOKEN) headers.Authorization = `Bearer ${process.env.FETCH_PROXY_TOKEN}`;
  try {
    const res = await fetch(proxyUrl, { headers });
    const body = await res.text();
    console.warn(`münchen-recon: status=${res.status} bytes=${body.length}`);
    const counts = ["Spielplan", "Oper", "Premiere", "Uhr", "Vorstellung", "JavaScript", "noscript", "ng-", "v-", "react", "vue", "Nationaltheater"]
      .map((k) => `${k}=${(body.match(new RegExp(k, "g")) ?? []).length}`);
    console.warn(`münchen-recon counts: ${counts.join(" ")}`);
    const main = body.search(/fallback-content/i);
    console.warn(`münchen-recon fallback: ${stripHtml(body.slice(main, main + 900))}`);
  } catch (err) {
    console.warn(`münchen-recon failed: ${err}`);
  }
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
  return `${m[3]}-${month}-${(m[1] ?? "").padStart(2, "0")}` as IsoDate;
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
