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
 * Musiktheater im Revier, Gelsenkirchen (`json-api` strategy).
 *
 * A Next.js site (mirtuell.net CMS) whose page state ships inline as
 * `__NEXT_DATA__`. The genre-filtered month calendars
 * (`/de/calendars/{YYYY}/{MM}/opera`) expose `pageProps.events[]`, each pointing
 * at a `performance` (`saison.name` + `slug`); walking the announced months gives
 * the set of opera productions without fetching every season entry. Each detail
 * page (`/de/performance/{saison}/{slug}`) carries the full
 * `pageProps.performance`: the title (`name`), composer (the "Oper von …"
 * `data.occassion.subHead`), the dated `mediator.events[]`, and `mediator.castItems`
 * (`type` 2 = creative function, 1 = sung role; person in `fullName`). Future-only
 * → Wikidata backfill. Canonical host has NO www (the www host 308-redirects).
 */

const BASE = "https://musiktheater-im-revier.de";
/** Musiktheater im Revier on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q1666920";
/** How far ahead to walk the month calendars (the announced range is ~18 months). */
const MONTHS_AHEAD = 18;

interface NextEvent {
  date?: string;
  data?: { ticketUrl?: string };
  mediators?: { performance?: NextPerformanceRef }[];
}
interface NextPerformanceRef {
  slug?: string;
  saison?: { name?: string };
}
interface NextPerformance {
  name?: string;
  genres?: { name?: string }[];
  data?: { occassion?: { subHead?: string; subSubHead?: string } };
  mediator?: { events?: NextEvent[]; castItems?: NextCastItem[] };
}
interface NextCastItem {
  data?: { type?: number };
  performanceRole?: { name?: string };
  persons?: { fullName?: string }[];
}

function parseNextData<T>(html: string, pick: (pageProps: Record<string, unknown>) => T): T | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m?.[1]) return null;
  try {
    const json = JSON.parse(m[1]) as { props?: { pageProps?: Record<string, unknown> } };
    return json.props?.pageProps ? pick(json.props.pageProps) : null;
  } catch {
    return null;
  }
}

export async function scrapeMusiktheaterImRevier(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  const refs = new Map<string, { saison: string; slug: string }>();
  const now = new Date();
  for (let i = 0; i < MONTHS_AHEAD; i++) {
    const dt = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const ym = `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, "0")}`;
    let events: NextEvent[];
    try {
      const html = await fetchHtml(`${BASE}/de/calendars/${ym}/opera`, ctx);
      events = parseNextData(html, (pp) => (pp.events as NextEvent[]) ?? []) ?? [];
    } catch {
      continue; // a month beyond the generated range 404s; keep walking
    }
    for (const e of events) {
      const perf = e.mediators?.[0]?.performance;
      const saison = perf?.saison?.name;
      if (perf?.slug && saison) refs.set(`${saison}/${perf.slug}`, { saison, slug: perf.slug });
    }
  }

  for (const { saison, slug } of refs.values()) {
    try {
      const prod = await buildProduction(ctx, saison, slug, window);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`musiktheater-im-revier: ${saison}/${slug} failed:`, err);
    }
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("musiktheater-im-revier: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "musiktheater-im-revier", productions };
}

async function buildProduction(
  ctx: FetchContext,
  saison: string,
  slug: string,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const detailUrl = `${BASE}/de/performance/${saison}/${slug}`;
  const html = await fetchHtml(detailUrl, ctx);
  const perf = parseNextData(html, (pp) => pp.performance as NextPerformance);
  if (!perf?.name) return null;
  if (!(perf.genres ?? []).some((g) => g?.name === "opera")) return null;

  const composer =
    composerFromText(stripHtml(perf.data?.occassion?.subHead ?? "")) ??
    composerFromText(stripHtml(perf.data?.occassion?.subSubHead ?? ""));
  const { creative_team, cast } = parseCast(perf.mediator?.castItems ?? []);

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const performances: RawPerformance[] = [];
  for (const e of perf.mediator?.events ?? []) {
    if (!e.date) continue;
    const date = e.date.slice(0, 10) as IsoDate;
    if (window.since && date < window.since) continue;
    // events store the clock time as a "Z" instant; the time portion is the local
    // curtain. A T00:00 means the time wasn't entered, not a midnight show.
    const hhmm = e.date.slice(11, 16);
    const time = hhmm === "00:00" ? null : hhmm;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    performances.push({
      date,
      time,
      status: date < today ? "past" : "scheduled",
      ticket_url: e.data?.ticketUrl || null,
    });
  }
  if (performances.length === 0) return null;
  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  return {
    source_production_id: `${saison}/${slug}`,
    work_title: perf.name,
    composer_name: composer,
    detail_url: detailUrl,
    creative_team,
    cast,
    performances,
  };
}

/** castItems: `type` 2 = creative function (Inszenierung, Musikalische Leitung, …),
 *  1 = sung role (Daland, …); each lists one or more persons by `fullName`. A
 *  mapped German function key is used when known, else the raw label is kept. */
function parseCast(castItems: NextCastItem[]): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const item of castItems) {
    const label = (item.performanceRole?.name ?? "").trim();
    if (!label) continue;
    const isCreative = item.data?.type === 2;
    for (const p of item.persons ?? []) {
      const name = (p.fullName ?? "").trim();
      if (!name || seen.has(`${label}|${name}`)) continue;
      seen.add(`${label}|${name}`);
      if (isCreative) {
        const credit = normalizeGermanCredit(label, name);
        creative_team.push(credit.function ? credit : { function: label, name });
      } else {
        cast.push({ role: label, name });
      }
    }
  }
  return { creative_team, cast };
}
