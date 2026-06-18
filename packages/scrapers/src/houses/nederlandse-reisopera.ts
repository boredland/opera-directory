import { decodeEntities, type FetchContext, fetchHtml, fetchRendered, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";

/**
 * Nederlandse Reisopera (`render`) — the Dutch national touring opera company
 * (Enschede), playing each production across a circuit of theatres. Next.js site,
 * Dutch. Discovery is static HTML, but the per-night TOUR SCHEDULE is rendered
 * client-side, so the detail pages are read through the headless render path:
 *   - `/programma-index` lists the productions at `/programma/{slug}` (static).
 *   - Each `/programma/{slug}?tab=tour` page, once RENDERED, carries everything:
 *     `<h1>` title; `<dt>Componist</dt><dd>…</dd>` composer; an `Artistiek team`
 *     and a `Cast` `<h3>` each followed by a `<p>` of `<strong>label</strong> name`
 *     runs (Dutch function labels mapped in-adapter); and the tour rows as
 *     "{day} {EnglishMonth} opera {start}-{end} {Venue} {City} Tickets". The year
 *     is taken from the Dutch full date ("31 oktober 2026") elsewhere on the page.
 *   - Opera gate: a composer + an announced character cast + tour dates — drops
 *     the sing-alongs, talks, education formats, and not-yet-cast future shows
 *     (whose singers still read "NN"); they reappear once a cast is announced.
 */

const BASE = "https://reisopera.nl";
const INDEX = `${BASE}/programma-index`;

const EN_MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
const NL_MONTHS =
  /(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(20\d{2})/i;

/** Dutch creative-function labels → canonical function slugs. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  "muzikale leiding": "conductor",
  dirigent: "conductor",
  regie: "director",
  choreografie: "choreographer",
  decorontwerp: "set-designer",
  decor: "set-designer",
  kostuumontwerp: "costume-designer",
  kostuums: "costume-designer",
  lichtontwerp: "lighting",
  licht: "lighting",
  koordirigent: "chorus-master",
  dramaturgie: "dramaturgy",
};

/** Cast rows that name an ensemble rather than a character. */
const ENSEMBLE_ROLE = /^(koor|dansers?|begeleiding|orkest|koren)$/i;

export async function scrapeNederlandseReisopera(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let slugs: string[] = [];
  try {
    const index = await fetchHtml(INDEX, ctx);
    slugs = [
      ...new Set(
        [...index.matchAll(/\/programma\/([a-z0-9-]+)(?:["'?])/g)].map((m) => m[1] as string),
      ),
    ].filter((s) => s !== "dit-seizoen" && s !== "index");
  } catch (err) {
    console.warn("nederlandse-reisopera: index fetch failed:", err);
    return { house_slug: "nederlandse-reisopera", productions };
  }

  for (const slug of slugs) {
    try {
      const html = await fetchRendered(`${BASE}/programma/${slug}?tab=tour`, ctx, { waitMs: 6000 });
      const prod = parseProduction(html, slug);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`nederlandse-reisopera: production ${slug} failed:`, err);
    }
  }

  return { house_slug: "nederlandse-reisopera", productions };
}

function parseProduction(html: string, slug: string): RawProduction | null {
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const composer = stripHtml(
    html.match(/<dt[^>]*>\s*Componist\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/)?.[1] ?? "",
  );
  if (!title || !composer) return null;

  const creative_team = parseCreditSection(html, "Artistiek team", true);
  const cast = parseCreditSection(html, "Cast", false);
  // Opera gate: composer (above) + a character cast + tour dates. (A Regie credit
  // is NOT required — chamber/adapted productions credit the director under other
  // labels; the cast + composer + tour are the reliable signal.)
  if (cast.length === 0) return null;

  const performances = parseTour(html);
  if (performances.length === 0) return null;

  return {
    source_production_id: `nederlandse-reisopera/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/programma/${slug}`,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances,
  };
}

function ogImage(html: string): string | null {
  return (
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1] ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)?.[1] ??
    null
  );
}

/** The `<p>` after a `<h3>{heading}</h3>` holds `<strong>label</strong> name<br>`
 *  runs. For the creative team, labels map to functions (unmapped crew dropped);
 *  for the cast, the label is the character role (ensembles dropped). */
function parseCreditSection(html: string, heading: string, creative: boolean): RawCredit[] {
  // "Artistiek team" sits in <h3><strong>…</strong></h3>, "Cast" bare in <h3>;
  // both are followed by a <p> of the credit runs.
  const block =
    html.match(new RegExp(`${heading}(?:</strong>)?\\s*</h[1-6]>([\\s\\S]*?)</p>`))?.[1] ?? "";
  const out: RawCredit[] = [];
  for (const m of block.matchAll(/<strong>([\s\S]*?)<\/strong>([^<]*)/g)) {
    const label = stripHtml(m[1] ?? "");
    const name = decodeEntities(m[2] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!label || !name) continue;
    if (creative) {
      const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
      if (fn) out.push({ function: fn, name });
    } else if (!ENSEMBLE_ROLE.test(label)) {
      for (const n of name.split(/,\s*/)) if (n) out.push({ role: label, name: n });
    }
  }
  return out;
}

/** Rendered tour rows: "{day} {EnglishMonth} opera {start}-{end} {Venue} {City}
 *  Tickets". The year comes from the Dutch full date printed on the page. */
function parseTour(html: string): RawPerformance[] {
  const text = stripHtml(html);
  const year = Number.parseInt(text.match(NL_MONTHS)?.[3] ?? "", 10) || new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  const re =
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+opera\s+(\d{1,2}:\d{2})\s*-\s*\d{1,2}:\d{2}\s+([^\d]+?)\s+Tickets/gi;
  for (const m of text.matchAll(re)) {
    const month = EN_MONTHS[(m[2] ?? "").toLowerCase()];
    const day = Number.parseInt(m[1] ?? "", 10);
    if (!month || day < 1 || day > 31) continue;
    const date = isoFromParts(year, month, day);
    if (!date) continue;
    const time = m[3] ?? null;
    const venue_room = (m[4] ?? "").replace(/\s+/g, " ").trim() || null;
    const key = `${date}|${venue_room ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, venue_room, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}
