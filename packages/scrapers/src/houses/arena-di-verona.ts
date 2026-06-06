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

/**
 * Arena di Verona Opera Festival (`spielplan-html` strategy) — a summer FESTIVAL,
 * not a year-round house: the open-air Roman amphitheatre stages a single edition
 * each June–September and sits empty in winter, so the live scrape is the CURRENT
 * edition's opera programme, supplemented by Wikidata for past editions.
 *
 * ProcessWire CMS, English mirror under `/en/`. The festival programme page
 * (`/en/arena-verona-opera-festival/events/`) is a per-day calendar: each
 * `<li class="bh-calendarShow" data-filter-type="OPERA">` sits in a
 * `<div class="day" data-day="YYYY-MM-DD">` and carries the production title, its
 * detail URL, and the start time — every performance, all on one page. We group
 * those performances by detail URL into productions, then fetch each detail page
 * once for the production-level facts.
 *
 * The site's own `data-filter-type` is noisy (it tags galas/cantatas/ballets as
 * OPERA too), so opera is decided on the detail page: REQUIRE a composer AND a
 * sung cast of named character roles. Cantatas billed by voice type (Carmina
 * Burana → Soprano/Baritono) and ballets/galas (no composer, no character roles)
 * are dropped.
 *
 * Composer + credits are read from the (Italian/English) detail-page DOM, NOT the
 * German credit map: the composer from `<span class="label">Music</span>` and the
 * creative team from `<p class="spacer-bottom-1">Label</p>` blocks plus the lead
 * "Direttore"/"Conductor" row of the cast table. Italian/English credit labels are
 * mapped locally in CREDIT_LABELS below.
 */

const BASE = "https://www.arena.it";
const EVENTS_URL = `${BASE}/en/arena-verona-opera-festival/events/`;
const VENUE = "Arena di Verona";
/** Arena di Verona Festival (the opera event, not the amphitheatre building). */
const WIKIDATA_QID = "Q1185941";

/** Italian + English credit labels → canonical function keys (this site mixes both). */
const CREDIT_LABELS: Record<string, string> = {
  conductor: "conductor",
  direttore: "conductor",
  "musical director": "conductor",
  direction: "director",
  regia: "director",
  "direction and set design": "director",
  "regia e scene": "director",
  // A single artist (e.g. Stefano Poda) credited for the whole staging; map the
  // combined label to its leading function so the director isn't dropped.
  "direction, set design, costumes, lighting design, choreography": "director",
  "regia, scene, costumi, luci, coreografia": "director",
  "set design": "set-designer",
  scene: "set-designer",
  scenografia: "set-designer",
  costumes: "costume-designer",
  costumi: "costume-designer",
  lights: "lighting",
  lighting: "lighting",
  "lighting design": "lighting",
  luci: "lighting",
  choreography: "choreographer",
  coreografia: "choreographer",
  "chorus master": "chorus-master",
  "maestro del coro": "chorus-master",
};

/** Voice-type / instrument "roles" mark a concert or cantata billing (Carmina
 *  Burana → Soprano/Baritono, Viva Vivaldi → Violin), not a staged character. */
const NON_CHARACTER_ROLES = new Set([
  "soprano",
  "mezzosoprano",
  "mezzo-soprano",
  "contralto",
  "contraltista",
  "tenor",
  "tenore",
  "baritone",
  "baritono",
  "bass",
  "basso",
  "controtenore",
  "countertenor",
  "violin",
  "violino",
  "viola",
  "cello",
  "violoncello",
  "piano",
  "pianoforte",
  "voce recitante",
  "narrator",
  "soloist",
]);

/** A printed credit label maps to a creative function (else it's a sung role). */
function creditFunction(label: string): string | null {
  return CREDIT_LABELS[label.trim().toLowerCase().replace(/:\s*$/, "")] ?? null;
}

interface CalendarPerf {
  date: IsoDate;
  time: string | null;
  detailPath: string;
  title: string;
}

export async function scrapeArenaDiVerona(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const perfsByPath = groupByPath(parseCalendar(await fetchHtml(EVENTS_URL, ctx)));
    const today = new Date().toISOString().slice(0, 10);

    for (const [detailPath, perfRows] of perfsByPath) {
      try {
        const prod = await buildProduction(ctx, detailPath, perfRows, today);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`arena-di-verona: ${detailPath} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("arena-di-verona: programme scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("arena-di-verona: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "arena-di-verona", productions };
}

/** Each `<li data-filter-type="OPERA">` is one performance; its `<div class="day"
 *  data-day>` ancestor gives the date and a `time-secondary` icon gives the time. */
function parseCalendar(html: string): CalendarPerf[] {
  const out: CalendarPerf[] = [];
  const dayRe = /<div class="day" data-day="(\d{4}-\d{2}-\d{2})">/g;
  const days = [...html.matchAll(dayRe)];
  for (let i = 0; i < days.length; i++) {
    const date = days[i]?.[1] as IsoDate | undefined;
    const start = days[i]?.index ?? 0;
    const end = days[i + 1]?.index ?? html.length;
    if (!date) continue;
    const segment = html.slice(start, end);

    for (const [, block] of segment.matchAll(
      /<li class="bh-calendarShow"[^>]*data-filter-type="OPERA"[^>]*>([\s\S]*?)<\/li>/g,
    )) {
      if (!block) continue;
      const link = block.match(/href="(\/en\/arena-verona-opera-festival\/[^"]+\/)"/);
      const detailPath = link?.[1];
      if (!detailPath) continue;
      const title = stripHtml(block.match(/title="([^"]+)"/)?.[1] ?? "");
      const time = block.match(
        /time-secondary"><\/span>\s*<span class="label">\s*(\d{1,2}:\d{2})/,
      )?.[1];
      out.push({ date, time: time ?? null, detailPath, title });
    }
  }
  return out;
}

function groupByPath(perfs: CalendarPerf[]): Map<string, CalendarPerf[]> {
  const byPath = new Map<string, CalendarPerf[]>();
  for (const p of perfs) {
    const list = byPath.get(p.detailPath) ?? [];
    list.push(p);
    byPath.set(p.detailPath, list);
  }
  return byPath;
}

async function buildProduction(
  ctx: FetchContext,
  detailPath: string,
  perfRows: CalendarPerf[],
  today: string,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}${detailPath}`;
  const html = await fetchHtml(detailUrl, ctx);
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ");

  const composer = parseComposer(body);
  if (!composer) return null;

  const { creative_team, cast } = parseCredits(body);
  // No named character role ⇒ a gala, cantata or ballet sharing the OPERA tag.
  if (cast.length === 0) return null;

  const title =
    stripHtml(body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "") || perfRows[0]?.title || "";
  if (!title) return null;

  const performances: RawPerformance[] = perfRows
    .map(
      (p): RawPerformance => ({
        date: p.date,
        time: p.time,
        venue_room: VENUE,
        status: p.date < today ? "past" : "scheduled",
      }),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));

  return {
    source_production_id: detailPath.replace(/\/$/, "").split("/").pop() ?? detailPath,
    work_title: title,
    composer_name: composer,
    detail_url: detailUrl,
    creative_team,
    cast,
    performances,
  };
}

/** `<span class="label">Music</span><p class="text">Giuseppe Verdi</p>`. */
function parseComposer(body: string): string | null {
  const m = body.match(/<span class="label">Music<\/span>\s*<p class="text">([^<]+)<\/p>/);
  const name = m ? stripHtml(m[1] ?? "") : "";
  return name || null;
}

/**
 * Two credit sources on the detail page:
 *   - production team: `<p class="spacer-bottom-1">Label</p><p><a class="cta">Name
 *     </a></p>` blocks (Direction, Set design, Costumes, …);
 *   - the cast table `<th scope="row">Role</th><td><a class="…cta">Name</a></td>`,
 *     whose lead "Direttore"/"Conductor" row is the conductor (a creative credit),
 *     the rest sung character roles. We read the FIRST cast table — later tables are
 *     per-night recasts of the same roles.
 */
function parseCredits(body: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();

  for (const [, rawLabel, namesBlock] of body.matchAll(
    /<p class="spacer-bottom-1">([^<]+)<\/p>\s*<p>([\s\S]*?)<\/p>/g,
  )) {
    const fn = creditFunction(stripHtml(rawLabel ?? ""));
    if (!fn) continue;
    for (const name of parseNames(namesBlock ?? "")) {
      const key = `${fn}|${name}`;
      if (seenCreative.has(key)) continue;
      seenCreative.add(key);
      creative_team.push({ function: fn, name });
    }
  }

  const table = body.match(/<table class="tbl cast"[\s\S]*?<\/table>/)?.[0] ?? "";
  for (const [, rawRole, rawCell] of table.matchAll(
    /<th scope="row">([^<]+)<\/th>\s*<td>([\s\S]*?)<\/td>/g,
  )) {
    const role = stripHtml(rawRole ?? "");
    const name = parseNames(rawCell ?? "")[0];
    if (!role || !name) continue;
    if (NON_CHARACTER_ROLES.has(role.toLowerCase())) continue; // concert soloist, not a staged role
    const fn = creditFunction(role);
    if (fn) {
      const key = `${fn}|${name}`;
      if (!seenCreative.has(key)) {
        seenCreative.add(key);
        creative_team.push({ function: fn, name });
      }
    } else {
      cast.push({ role, name });
    }
  }

  return { creative_team, cast };
}

/** Names are `<a class="… cta …">Name</a>` links; the per-date "12/06" chips share
 *  that class, so drop bare dd/mm tokens. */
function parseNames(block: string): string[] {
  const names: string[] = [];
  for (const [, raw] of block.matchAll(/class="[^"]*\bcta\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    const name = stripHtml(raw ?? "");
    if (name && !/^\d{1,2}\/\d{1,2}$/.test(name)) names.push(name);
  }
  return names;
}
