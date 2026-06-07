import type { IsoDate } from "@opera-directory/schema";
import type { FetchContext } from "../fetch";
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
 * Oberösterreichisches Landestheater Linz (`json-api` strategy).
 *
 * Linz's multi-genre Landestheater — opera + operetta at the Musiktheater am
 * Volksgarten alongside musical, ballet (Tanz), Schauspiel and Konzert. The site
 * is a TYPO-style SSR shell whose programme widgets hydrate from a single public
 * GraphQL endpoint (`/ltl-events-api`, an urql client discovered in the Vue
 * bundle). No remote JS runs here — we POST the same queries the page would:
 *   - `productions(limit)` → every production of the current + next season with
 *     its `branch` (genre), `composer`, `season`, `premiere` and `location`.
 *   - `events(limit)` → every announced performance (the live what's-on feed),
 *     each carrying `startDate`, `cancelled`, `location.stageName` and a
 *     `subjectOf` that is the parent production's identifier — the join key.
 *   - `production(identifier)` → the Besetzung: `contributor[]` (creative team,
 *     `namedPosition` label) and `performer[]` (sung roles, `roleName`).
 *
 * GENRE FILTER (the opera gate). The house mixes Oper/Operette/Musical/Tanz/
 * Schauspiel/Konzert/…; we keep only `branch.name` ∈ {Oper, Operette, Oper am
 * Klavier} and additionally require a composer (the opera gate), which drops
 * everything else cleanly at the production level.
 *
 * DISCOVERY is the GraphQL feed itself, which is future-only — `events` lists
 * from "today" through the end of the announced run with no offset/date paging
 * (offset is ignored upstream), so this adapter has no archive walk. Productions
 * whose run has already finished this season still surface via their `premiere`
 * date as a single past performance. The deep past comes from Wikidata backfill.
 */

const API = "https://www.landestheater-linz.at/ltl-events-api";

/** Landestheater Linz on Wikidata — Q1802665 ("Linz State Theatre", instance-of
 *  theatre organisation Q11812394, carrying the official website P856). Verified
 *  via wbsearchentities AND SPARQL: it holds productions via P4647 (e.g. Philip
 *  Glass's "Kepler", premiered here), whereas the near-duplicate Q118495441 holds
 *  none and has no website — so Q1802665 is the record with backfill data. */
const WIKIDATA_QID = "Q1802665";

/** branch.name values that are opera/operetta (vs. musical/Tanz/Schauspiel/…). */
const OPERA_BRANCHES = new Set(["oper", "operette", "oper am klavier"]);

interface GqlBranch {
  name: string | null;
}
interface GqlLocation {
  stageName: string | null;
  locationName: string | null;
}
interface GqlPremiere {
  type: string | null;
  startDate: string | null;
}
interface GqlProduction {
  identifier: string;
  name: string | null;
  composer: string | null;
  season: string | null;
  branch: GqlBranch | null;
  location: GqlLocation | null;
  premiere: GqlPremiere | null;
}
interface GqlEvent {
  identifier: number;
  startDate: string | null;
  cancelled: boolean | null;
  subjectOf: string | null;
  location: GqlLocation | null;
}
interface GqlActor {
  givenName: string | null;
  familyName: string | null;
  alternateName: string | null;
}
interface GqlRole {
  roleName: string | null;
  namedPosition: string | null;
  actor: GqlActor[] | null;
}
interface GqlBesetzung {
  contributor: GqlRole[] | null;
  performer: GqlRole[] | null;
}

const PRODUCTIONS_QUERY = `{ productions(limit: 1000) {
  identifier name composer season
  branch { name }
  location { stageName locationName }
  premiere { type startDate }
} }`;

const EVENTS_QUERY = `{ events(limit: 2000) {
  identifier startDate cancelled subjectOf
  location { stageName locationName }
} }`;

const BESETZUNG_QUERY = `query production($identifier: String!) {
  production(identifier: $identifier) {
    contributor { namedPosition actor { givenName familyName alternateName } }
    performer { roleName actor { givenName familyName alternateName } }
  }
}`;

export async function scrapeLandestheaterLinz(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const [prods, events] = await Promise.all([
      gqlPost<{ productions: GqlProduction[] }>(ctx, PRODUCTIONS_QUERY),
      gqlPost<{ events: GqlEvent[] }>(ctx, EVENTS_QUERY),
    ]);

    const opera = (prods.productions ?? []).filter(isOperaProduction);
    const perfsByProduction = groupPerformances(events.events ?? [], window);

    for (const prod of opera) {
      try {
        const built = await buildProduction(
          prod,
          perfsByProduction.get(prod.identifier),
          ctx,
          window,
        );
        if (built) productions.push(built);
      } catch (err) {
        console.warn(`landestheater-linz: production ${prod.identifier} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("landestheater-linz: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("landestheater-linz: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "landestheater-linz", productions };
}

/** The opera gate: an opera/operetta branch AND a named composer. */
function isOperaProduction(p: GqlProduction): boolean {
  const branch = p.branch?.name?.trim().toLowerCase();
  return !!branch && OPERA_BRANCHES.has(branch) && !!p.composer?.trim();
}

/** Group announced performances by their parent production id, honouring
 *  `window.since` and deduping on date+time. */
function groupPerformances(
  events: GqlEvent[],
  window: ScrapeWindow,
): Map<string, RawPerformance[]> {
  const today = new Date().toISOString().slice(0, 10);
  const byProduction = new Map<string, RawPerformance[]>();
  const seen = new Set<string>();

  for (const e of events) {
    if (!e.subjectOf || !e.startDate) continue;
    const date = e.startDate.slice(0, 10) as IsoDate;
    const time = e.startDate.slice(11, 16) || null;
    if (window.since && date < window.since) continue;

    const key = `${e.subjectOf}|${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const list = byProduction.get(e.subjectOf) ?? [];
    list.push({
      date,
      time,
      venue_room: e.location?.stageName?.trim() || e.location?.locationName?.trim() || null,
      status: e.cancelled ? "cancelled" : date < today ? "past" : "scheduled",
    });
    byProduction.set(e.subjectOf, list);
  }

  return byProduction;
}

/**
 * Build a production from its programme row, its announced performances and its
 * Besetzung. A production whose run has already played out this season has no
 * future events; we keep it visible via its premiere date as a single past
 * performance. Requires at least one performance after the window gate.
 */
async function buildProduction(
  prod: GqlProduction,
  perfs: RawPerformance[] | undefined,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const title = prod.name?.trim();
  if (!title) return null;

  const performances = [...(perfs ?? [])];
  if (performances.length === 0) {
    const premiere = premierePerformance(prod);
    if (premiere && !(window.since && premiere.date < window.since)) performances.push(premiere);
  }
  if (performances.length === 0) return null;

  performances.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );

  const { creative_team, cast } = await fetchBesetzung(prod.identifier, ctx);

  return {
    source_production_id: `landestheater-linz/${prod.identifier}`,
    work_title: title,
    composer_name: prod.composer?.trim() || null,
    premiere_season: prod.season?.trim() || null,
    premiere_date: premiereDate(prod),
    is_revival: prod.premiere?.type?.toLowerCase().includes("wiederaufnahme") || undefined,
    detail_url: `https://www.landestheater-linz.at/stuecke/detail?ref=${prod.identifier}`,
    creative_team,
    cast,
    performances,
  };
}

/** The premiere as a dated performance (used only when no events remain). */
function premierePerformance(prod: GqlProduction): RawPerformance | null {
  const date = premiereDate(prod);
  if (!date) return null;
  return {
    date,
    venue_room: prod.location?.stageName?.trim() || prod.location?.locationName?.trim() || null,
    status: "past",
  };
}

/** `premiere.startDate` is an ISO timestamp; we keep the calendar date only. */
function premiereDate(prod: GqlProduction): IsoDate | null {
  const raw = prod.premiere?.startDate;
  return raw ? (raw.slice(0, 10) as IsoDate) : null;
}

/** Cast + creative team from the production's GraphQL Besetzung. A `namedPosition`
 *  the German credit map knows is a creative function; the rest (and every sung
 *  `roleName`) are cast. Multiple actors per role are split into one credit each. */
async function fetchBesetzung(
  identifier: string,
  ctx: FetchContext,
): Promise<{ creative_team: RawCredit[]; cast: RawCredit[] }> {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  try {
    const data = await gqlPost<{ production: GqlBesetzung | null }>(ctx, BESETZUNG_QUERY, {
      identifier,
    });
    const production = data.production;
    if (!production) return { creative_team, cast };

    for (const c of production.contributor ?? []) {
      const label = c.namedPosition?.trim();
      if (!label) continue;
      for (const name of actorNames(c.actor)) {
        const credit = normalizeGermanCredit(label, name);
        if (credit.function) {
          const key = `${credit.function}|${name}`;
          if (seenCreative.has(key)) continue;
          seenCreative.add(key);
          creative_team.push(credit);
        } else {
          pushCast(cast, seenCast, label, name);
        }
      }
    }

    for (const p of production.performer ?? []) {
      const role = p.roleName?.trim();
      if (!role) continue;
      for (const name of actorNames(p.actor)) pushCast(cast, seenCast, role, name);
    }
  } catch (err) {
    console.warn(`landestheater-linz: besetzung ${identifier} failed:`, err);
  }

  return { creative_team, cast };
}

function pushCast(cast: RawCredit[], seen: Set<string>, role: string, name: string): void {
  const key = `${role}|${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  cast.push({ role, name });
}

/** Prefer the joined "Given Family" name; fall back to `alternateName`. */
function actorNames(actors: GqlActor[] | null): string[] {
  const names: string[] = [];
  for (const a of actors ?? []) {
    const full = [a.givenName?.trim(), a.familyName?.trim()].filter(Boolean).join(" ").trim();
    const name = full || a.alternateName?.trim() || "";
    if (name) names.push(name);
  }
  return names;
}

/** POST a GraphQL query to the events API and return its `data`. */
async function gqlPost<T>(
  ctx: FetchContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const proxyUrl = ctx.proxy ? `${ctx.proxy.url}?url=${encodeURIComponent(API)}` : API;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": ctx.userAgent,
  };
  if (ctx.proxy?.token) headers.Authorization = `Bearer ${ctx.proxy.token}`;

  const res = await fetch(proxyUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables: variables ?? {} }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`graphql POST failed: ${API} → ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!json.data) throw new Error(`graphql returned no data: ${JSON.stringify(json.errors)}`);
  return json.data;
}
