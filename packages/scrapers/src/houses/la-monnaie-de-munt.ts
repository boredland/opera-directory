import type { IsoDate } from "@opera-directory/schema";
import {
  decodeEntities,
  extractEventJsonLd,
  type FetchContext,
  fetchHtml,
  stripHtml,
} from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * La Monnaie / De Munt (`jsonld-event` strategy) — Belgium's federal opera house
 * in Brussels (FR "Théâtre Royal de la Monnaie" / NL "Koninklijke
 * Muntschouwburg"). We scrape the ENGLISH site (`/en/`), which carries English
 * credit labels; `backfill` appends Wikidata for the deep past.
 *
 * The Opera-filtered programme index (`/en/program?c=1`) links each show as
 * `/en/program/{id}-{slug}`, but that category still lets in non-staged items
 * (guided tours, "Young Opera" events, spoken pieces). Each detail page mixes
 * two structured sources, neither complete alone:
 *   - One schema.org `Event` JSON-LD node PER NIGHT (`startDate` with TZ offset,
 *     `location.name`, `eventStatus`) — the reliable, on-sale performance list.
 *     It carries NO composer and only an unlabeled `performer` string, so it is
 *     used only for the dated showings.
 *   - The page <h1> `prod-title`: the work title, then (in a smaller inner
 *     `<span style="font-size:…">`) the COMPOSER. A double bill keeps both in one
 *     fs-span ("Cavalleria rusticana & Pagliacci … Mascagni & Leoncavallo"); a
 *     non-opera (a dance/spoken piece like "Ali", "Burmese days") has no composer
 *     span at all.
 *   - The `#cast` credits block: `<span class="role-label">LABEL</span><span
 *     class="names">NAME</span>` pairs carrying BOTH the creative team (mapped
 *     English labels) and the sung cast (everything else — character names).
 *
 * FILTERING to staged opera: REQUIRE a composer (the opera gate). A guided tour
 * or spoken piece has no composer span and drops out; concerts/recitals/dance
 * live under other category ids and never reach this scrape.
 *
 * `startDate` is a TZ-offset local ISO ("2026-06-17T20:00:00+02:00"); the date +
 * HH:MM are read straight off the string, not timezone-converted.
 */

const BASE = "https://www.lamonnaiedemunt.be";
const VENUE = "La Monnaie / De Munt";

/** La Monnaie on Wikidata — the opera house Q551479 ("Royal Theatre of La
 *  Monnaie", instance-of opera house in Brussels), verified via wbsearchentities
 *  (alias "La Monnaie"). It carries P4647 world-premiere relations (194 items;
 *  the sibling company record Q54805195 carries the messier P272 productions but
 *  yields fewer titled, composer-bearing works), with composer (P86) +
 *  first-performance date (P1191) for backfill resolution anchors. */
const WIKIDATA_QID = "Q551479";

/** English credit `role-label`s → canonical function slugs. La Monnaie sometimes
 *  prints combined labels ("Director, Set, Costume & Lighting Designer"); those
 *  don't match an exact key and are dropped rather than guessed. Any label not
 *  mapped here is treated as a sung character role. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  director: "director",
  "stage director": "director",
  "set designer": "set-designer",
  "set design": "set-designer",
  "costume designer": "costume-designer",
  costumes: "costume-designer",
  "lighting designer": "lighting",
  lighting: "lighting",
  choreographer: "choreographer",
  choreography: "choreographer",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
  dramaturge: "dramaturgy",
  dramaturges: "dramaturgy",
  dramaturgy: "dramaturgy",
};

/** Credit `role-label`s that are neither a lead creative function nor a sung
 *  character — production-house metadata blocks and unmapped creative variants
 *  (combined labels like "Director, Set, Costume & Lighting Designer", or crew
 *  like "Set Design Collaborator"). Dropped so they don't pollute the sung cast. */
const CAST_NOISE =
  /^(production|coproduction|co-production|with the|in collaboration|orchestra|chorus of|children'?s chorus|symphony)|director|designer|design|choreograph|dramaturg|conductor|collaborator|chorus master|libretto|music/i;

export async function scrapeLaMonnaieDeMunt(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectOperaSlugs(ctx)) {
      try {
        const prod = parseProduction(
          await fetchHtml(`${BASE}/en/program/${slug}`, ctx),
          slug,
          window,
        );
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`la-monnaie-de-munt: program ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("la-monnaie-de-munt: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("la-monnaie-de-munt: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "la-monnaie-de-munt", productions };
}

/** Collect unique `{id}-{slug}` ids from the Opera-filtered programme index
 *  (`?c=1`). Non-opera items the category lets through carry no composer span and
 *  are dropped downstream. */
async function collectOperaSlugs(ctx: FetchContext): Promise<string[]> {
  const html = await fetchHtml(`${BASE}/en/program?c=1`, ctx);
  const slugs = new Set<string>();
  for (const [, slug] of html.matchAll(/\/en\/program\/(\d+-[a-z0-9-]+)/g)) {
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string, window: ScrapeWindow): RawProduction | null {
  const { title, composer } = parseTitleAndComposer(html);
  // No composer span ⇒ a guided tour / spoken / dance piece the category let in.
  if (!composer || !title) return null;

  const performances = parsePerformances(html, window);
  if (performances.length === 0) return null;

  const { creative_team, cast } = parseCredits(html);

  return {
    source_production_id: `la-monnaie-de-munt/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/en/program/${slug}`,
    image_url: parseImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** The <h1> `prod-title` holds the work title then, in a smaller inner styled
 *  span, the composer. The composer is the LAST `<span style="font-size:…">`
 *  inside the block; the title is everything before it (with `<br/>` collapsed). */
function parseTitleAndComposer(html: string): { title: string | null; composer: string | null } {
  const block = html.match(/<div class="prod-title">([\s\S]*?)<\/div>/)?.[1];
  if (!block) return { title: null, composer: null };

  const inner = [...block.matchAll(/<span[^>]*style="font-size:[^"]*"[^>]*>([\s\S]*?)<\/span>/g)];
  const last = inner[inner.length - 1];
  if (!last?.[1]) return { title: cleanLine(block) || null, composer: null };

  const composer = cleanLine(last[1]);
  const title = cleanLine(block.slice(0, last.index));
  return { title: title || null, composer: composer || null };
}

function parseImage(html: string): string | null {
  const m = html.match(/<meta property="og:image" content="([^"]+)"/);
  return m?.[1] ?? null;
}

/** Performances are the per-night schema.org `Event` JSON-LD nodes. Each carries
 *  a TZ-offset local `startDate`; date + HH:MM are read off the string. */
function parsePerformances(html: string, window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const node of extractEventJsonLd(html)) {
    const start = typeof node.startDate === "string" ? node.startDate : "";
    const m = start.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
    if (!m) continue;
    const date = m[1] as IsoDate;
    const time = m[2] ?? null;
    if (window.since && date < window.since) continue;

    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, venue_room: VENUE, status: eventStatus(node.eventStatus, date, today) });
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

function eventStatus(status: unknown, date: IsoDate, today: string): RawPerformance["status"] {
  if (typeof status === "string") {
    if (/EventCancelled/i.test(status)) return "cancelled";
    if (/SoldOut/i.test(status)) return "sold_out";
  }
  return date < today ? "past" : "scheduled";
}

/** The `#cast` credits block: `role-label`/`names` pairs. A mapped label is a
 *  creative-team function; an unmapped one (not crew noise) is a sung character
 *  role. We scope to the cast anchor so unrelated `role-label`s can't leak in. */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seenCreative = new Set<string>();
  const seenCast = new Set<string>();

  const start = html.indexOf('id="cast"');
  const scope = start === -1 ? html : html.slice(start);

  for (const [, rawLabel, rawNames] of scope.matchAll(
    /<span class="role-label">([\s\S]*?)<\/span>\s*<span class="names">([\s\S]*?)<\/span>/g,
  )) {
    const label = cleanLine(rawLabel ?? "");
    if (!label) continue;
    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];

    for (const name of splitNames(rawNames ?? "")) {
      if (fn) {
        const key = `${fn}|${name}`;
        if (seenCreative.has(key)) continue;
        seenCreative.add(key);
        creative_team.push({ function: fn, name });
      } else {
        if (CAST_NOISE.test(label)) continue;
        const key = `${label}|${name}`;
        if (seenCast.has(key)) continue;
        seenCast.add(key);
        cast.push({ role: label, name });
      }
    }
  }

  return { creative_team, cast };
}

/** A `names` span may list several names (co-credits / alternate casts), comma-
 *  separated; an alternate carries a parenthetical performance-date qualifier
 *  ("ATALLA AYAN (18, 21, 24.6)") whose own commas must NOT split the name. Drop
 *  the parenthetical first, then split on the remaining commas. */
function splitNames(raw: string): string[] {
  return cleanLine(raw)
    .replace(/\s*\([^)]*\)/g, "")
    .split(/\s*,\s*/)
    .map((n) => n.replace(/[°*‡†§]+\s*$/, "").trim())
    .filter((n) => n.length >= 2 && n.length <= 80);
}

/** Strip tags, decode entities, collapse whitespace — for inline credit/title fragments. */
function cleanLine(html: string): string {
  return stripHtml(decodeEntities(html));
}
