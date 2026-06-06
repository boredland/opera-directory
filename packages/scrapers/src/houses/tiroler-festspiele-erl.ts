import type { IsoDate } from "@opera-directory/schema";
import { extractEventJsonLd, type FetchContext, fetchHtml, stripHtml } from "../fetch";
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
 * Tiroler Festspiele Erl — the opera festival in Erl, Tyrol/Austria
 * (`spielplan-html`, FESTIVAL).
 *
 * A two-edition festival: a Summer edition (~July, Wagner-heavy in the wooden
 * Passionsspielhaus + the Festspielhaus) and a Winter edition (around New Year,
 * in the Festspielhaus). Both editions sit in one published season, so a live
 * scrape sees the CURRENT + next announced opera programme; the deep past comes
 * from Wikidata backfill.
 *
 * Laravel site; the whole spielplan rides in one inline blob,
 * `window.spielplanData = {de:{filter,entries:[…]}}` on `/spielplan-karten`.
 * Each entry is one dated performance with `event_type_label`, `title`
 * ("{Composer}: {WORK}"), `date_string`, `starting_at` ("19:00 Uhr"), `subtitle`
 * (the Spielort), `tickets_available` and a `link` (`/events/{slug}#date`).
 *
 * Opera gate: keep `event_type_label` "Oper" / "Oper konzertant" (drops the many
 * concerts, recitals, Specials and Polsterkonzerte) AND require the composer-colon
 * in the title — that also drops the NEUJAHRSKONZERT, which is filed as "Oper" but
 * carries no composer. Composer is the part before the first colon.
 *
 * Performances group by `event_id` into one production each. Cast + creative team
 * come from the detail page's `TheaterEvent` JSON-LD `performer[]`, where each
 * `jobTitle` is a German function label (Musikalische Leitung, Regie, Bühne →
 * creative) or a sung role (Senta, Holländer → cast). Venue + dates/times stay
 * with the spielplan blob (the JSON-LD location is a bare @id ref).
 */

const BASE = "https://www.tiroler-festspiele.at";
const SPIELPLAN_URL = `${BASE}/spielplan-karten`;
/** Tiroler Festspiele Erl on Wikidata — Q1580354 ("music festival"), verified via
 *  wbsearchentities (the GmbH company Q108267626 is a separate entity). It carries
 *  no P4647/P272 production relations today, so backfill currently yields nothing
 *  there; the QID rides along for when those facts get modelled. */
const WIKIDATA_QID = "Q1580354";

const OPERA_TYPES = new Set(["Oper", "Oper konzertant"]);

interface SpielplanEntry {
  event_id?: string;
  title?: string;
  date_string?: string;
  starting_at?: string | null;
  subtitle?: string | null;
  tickets_available?: number | null;
  event_type_label?: string | null;
  link?: string | null;
}

interface JsonLdPerson {
  "@type"?: string;
  name?: string;
  jobTitle?: string;
}

export async function scrapeTirolerFestspieleErl(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  try {
    const byEvent = await parseSpielplan(ctx, window);
    for (const [eventId, group] of byEvent) {
      try {
        const prod = await buildProduction(ctx, eventId, group);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`tiroler-festspiele-erl: ${eventId} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("tiroler-festspiele-erl: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("tiroler-festspiele-erl: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "tiroler-festspiele-erl", productions };
}

interface EventGroup {
  title: string;
  detailUrl: string | null;
  performances: RawPerformance[];
}

/** Pull `window.spielplanData`, keep opera entries, group performances by event. */
async function parseSpielplan(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<Map<string, EventGroup>> {
  const html = await fetchHtml(SPIELPLAN_URL, ctx);
  const m = html.match(/window\.spielplanData\s*=\s*(\{[\s\S]*?\});/);
  if (!m?.[1]) throw new Error("spielplanData blob not found");
  const data = JSON.parse(m[1]) as { de?: { entries?: SpielplanEntry[] } };

  const today = new Date().toISOString().slice(0, 10);
  const byEvent = new Map<string, EventGroup>();

  for (const e of data.de?.entries ?? []) {
    if (!e.event_id || !e.title || !e.date_string) continue;
    if (!OPERA_TYPES.has(e.event_type_label ?? "")) continue;
    if (!e.title.includes(":")) continue; // drops the NEUJAHRSKONZERT (no composer)

    const date = e.date_string as IsoDate;
    if (window.since && date < window.since) continue;

    const group = byEvent.get(e.event_id) ?? {
      title: e.title,
      detailUrl: e.link ? `${BASE}${e.link.split("#")[0]}` : null,
      performances: [],
    };
    group.performances.push({
      date,
      time: parseTime(e.starting_at),
      venue_room: e.subtitle?.trim() || null,
      status: statusOf(e.tickets_available, date, today),
    });
    byEvent.set(e.event_id, group);
  }

  for (const group of byEvent.values()) {
    group.performances.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
  }
  return byEvent;
}

async function buildProduction(
  ctx: FetchContext,
  eventId: string,
  group: EventGroup,
): Promise<RawProduction | null> {
  if (group.performances.length === 0) return null;

  const [composerPart, ...rest] = group.title.split(":");
  const composer = composerPart?.trim() || null;
  const workTitle = rest.join(":").trim();
  if (!composer || !workTitle) return null;

  let cast: RawCredit[] = [];
  let creative: RawCredit[] = [];
  if (group.detailUrl) {
    try {
      ({ cast, creative } = await parseCredits(ctx, group.detailUrl));
    } catch (err) {
      console.warn(`tiroler-festspiele-erl: credits ${group.detailUrl} failed:`, err);
    }
  }

  return {
    source_production_id: eventId,
    work_title: workTitle,
    composer_name: composer,
    detail_url: group.detailUrl,
    creative_team: creative,
    cast,
    performances: group.performances,
  };
}

/** Cast + creative team from the detail page's TheaterEvent JSON-LD `performer[]`:
 *  a mapped German function jobTitle → creative team, anything else → a sung role. */
async function parseCredits(
  ctx: FetchContext,
  url: string,
): Promise<{ cast: RawCredit[]; creative: RawCredit[] }> {
  const html = await fetchHtml(url, ctx);
  const cast: RawCredit[] = [];
  const creative: RawCredit[] = [];
  const seen = new Set<string>();

  for (const ev of extractEventJsonLd(html)) {
    const performers = ev.performer;
    if (!Array.isArray(performers)) continue;
    for (const p of performers as JsonLdPerson[]) {
      const name = stripHtml(p?.name ?? "").trim();
      const label = (p?.jobTitle ?? "").trim();
      if (!name || !label) continue;
      const credit = normalizeGermanCredit(label, name);
      const fn = credit.function ?? `role:${label}`;
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (credit.function) creative.push(credit);
      else cast.push({ role: label, name });
    }
  }
  return { cast, creative };
}

/** "19:00 Uhr" → "19:00". */
function parseTime(raw: string | null | undefined): string | null {
  const m = (raw ?? "").match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1]?.padStart(2, "0")}:${m[2]}` : null;
}

function statusOf(
  tickets: number | null | undefined,
  date: IsoDate,
  today: string,
): RawPerformance["status"] {
  if (date < today) return "past";
  if (tickets === 0) return "sold_out";
  return "scheduled";
}
