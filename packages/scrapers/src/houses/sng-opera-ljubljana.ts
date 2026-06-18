import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * SNG Opera in balet Ljubljana (`spielplan-html` + GraphQL) — the Slovene National
 * Theatre Opera and Ballet, Ljubljana. SilverStripe site with a full English /en/
 * mirror, plain fetch (200 to the crawler UA, no proxy), no schema.org Event JSON-LD:
 *   - Discovery: the current-season page (`/en/seasoni-202425`) links every staging
 *     as `/en/programme/event/{opera|balet}/{slug}` — the `/opera/` genre segment IS
 *     the opera filter (ballet never enters).
 *   - Detail page: the work title is the non-`visuallyhidden` `<h1>`. Creative team
 *     and cast share one markup — `<div class="cast"><ul><li>{label} <strong>{names}
 *     </strong></li>` — split by their `<h3>` heading ("Artists" → creative, English
 *     labels mapped, "Music" is the composer; "Entire cast" → character roles). Names
 *     are " / "-separated (alternating casts) with guest markers ("a. g.") stripped.
 *   - Performances: the dates are NOT in the HTML (a React widget). They come from
 *     the site's GraphQL API (`POST /graphql`, `readEventShows`) keyed by the page's
 *     `data-eventid`, returning startDate/startTime/location/soldout per night.
 *   - Opera gate: `/opera/` URL AND a person-name composer AND (a cast list OR a
 *     director credit).
 */

const BASE = "https://www.opera.si";

/** English creative-function labels → canonical function slugs (substring-matched). */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/conductor/i, "conductor"],
  [/chorus master|choir ?master/i, "chorus-master"],
  [/choreograph/i, "choreographer"],
  [/stage director|^director|direction|directed/i, "director"],
  [/set design|scenograph/i, "set-designer"],
  [/costume/i, "costume-designer"],
  [/light/i, "lighting"],
  [/dramaturg/i, "dramaturg"],
];

const SHOWS_QUERY = `query R($startDate: String!, $eventID: ID, $limit: Int){
  readEventShows(filter: { startDate: { gte: $startDate } eventID: { eq: $eventID } } limit: $limit sort: { startDate: ASC }){
    nodes { startDate startTime location soldout event { title eventAuthor eventTypeName } }
  }
}`;

interface ShowNode {
  startDate: string;
  startTime: string | null;
  location: string | null;
  soldout: boolean;
  event: { title: string; eventAuthor: string | null; eventTypeName: string | null };
}

export async function scrapeSngOperaLjubljana(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let urls: string[];
  try {
    const season = await fetchHtml(`${BASE}/en/seasoni-202425`, ctx);
    urls = [
      ...new Set(
        [...season.matchAll(/\/en\/programme\/event\/opera\/[a-z0-9-]+/g)].map(
          (m) => `${BASE}${m[0]}`,
        ),
      ),
    ];
  } catch (err) {
    console.warn("sng-opera-ljubljana: season fetch failed:", err);
    return { house_slug: "sng-opera-ljubljana", productions };
  }

  const since =
    window.mode === "backfill"
      ? (window.since ?? "2000-01-01")
      : new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);

  for (const url of urls) {
    try {
      const html = await fetchHtml(url, ctx);
      const prod = await parseProduction(html, url, since, ctx);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`sng-opera-ljubljana: ${url} failed:`, err);
    }
  }

  return { house_slug: "sng-opera-ljubljana", productions };
}

async function parseProduction(
  html: string,
  url: string,
  since: string,
  ctx: FetchContext,
): Promise<RawProduction | null> {
  const eventId = html.match(/data-eventid="(\d+)"/)?.[1];
  if (!eventId) return null;

  const { composer, creative_team } = parseSection(html, "Artists", "creative");
  const cast = parseSection(html, "Entire cast", "cast").cast;

  const shows = await fetchShows(eventId, since, ctx);
  const title =
    shows[0]?.event.title ??
    stripHtml(
      [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)]
        .map((m) => m[0])
        .find((h) => !/visuallyhidden/.test(h))
        ?.replace(/<\/?h1[^>]*>/g, "") ?? "",
    );
  const composerName = composer || shows[0]?.event.eventAuthor || "";
  if (!title || !isPersonName(composerName)) return null;
  if (cast.length === 0 && !creative_team.some((c) => c.function === "director")) return null;

  const today = new Date().toISOString().slice(0, 10);
  const performances: RawPerformance[] = shows.map((s) => ({
    date: s.startDate as IsoDate,
    time: (s.startTime ?? "").slice(0, 5) || null,
    venue_room: s.location || null,
    status: s.soldout ? "sold_out" : s.startDate < today ? "past" : "scheduled",
  }));

  const slug = url.match(/\/opera\/([a-z0-9-]+)/)?.[1] ?? eventId;
  return {
    source_production_id: `sng-opera-ljubljana/${slug}`,
    work_title: title,
    composer_name: composerName,
    detail_url: url,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances: performances.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    ),
  };
}

/** The `<div class="cast">` under an `<h3>{heading}</h3>`. Two interchangeable
 *  markups appear — `<li>{label} <strong>{names}</strong></li>` and `<p><span
 *  class="wrap"><span>{label}</span></span><strong>{names}</strong></p>` — both
 *  handled by reading the label text before each `<strong>`. "Artists" → composer
 *  ("Music") + creative; "Entire cast" → character roles. Names are " / "-separated
 *  (alternating casts) with guest markers ("k. g." / "a. g.") stripped. */
function parseSection(
  html: string,
  heading: string,
  kind: "creative" | "cast",
): { composer: string; creative_team: RawCredit[]; cast: RawCredit[] } {
  const block =
    html.match(new RegExp(`${heading}</h3>[\\s\\S]*?<div class="cast">([\\s\\S]*?)</div>`))?.[1] ??
    "";
  let composer = "";
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  for (const li of block.matchAll(/<(?:li|p)\b[^>]*>([\s\S]*?)<strong>([\s\S]*?)<\/strong>/g)) {
    const label = stripHtml(li[1] ?? "");
    const names = stripHtml(li[2] ?? "")
      .split(/\s*\/\s*/)
      .map((n) => n.replace(/\s+[ak]\.\s*g\.\s*$/i, "").trim())
      .filter((n) => isPersonName(n));
    if (!label) continue;
    if (kind === "creative") {
      // The composer row is "Music" / "Music and libretto" — NOT "Music Archivist",
      // "Music Coach" etc.; take the first such row's first named person.
      if (!composer && /^music(\s+and\s+libretto)?\s*$/i.test(label)) {
        composer = names[0] ?? "";
        continue;
      }
      if (/^music\b/i.test(label)) continue; // other "Music …" roles aren't tracked
      const fn = CREATIVE_FUNCTIONS.find(([re]) => re.test(label))?.[1];
      if (!fn || /assistant/i.test(label)) continue;
      for (const name of names) {
        const key = `${fn}|${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        creative_team.push({ function: fn, name });
      }
    } else {
      if (/chorus|orchestra|ensemble/i.test(label)) continue;
      for (const name of names) {
        const key = `${label}|${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cast.push({ role: label, name });
      }
    }
  }
  return { composer, creative_team, cast };
}

async function fetchShows(eventId: string, since: string, ctx: FetchContext): Promise<ShowNode[]> {
  const res = await fetch(`${BASE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": ctx.userAgent },
    body: JSON.stringify({
      query: SHOWS_QUERY,
      variables: { startDate: since, eventID: eventId, limit: 200 },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`graphql → ${res.status}`);
  const json = (await res.json()) as { data?: { readEventShows?: { nodes?: ShowNode[] } } };
  const nodes = json.data?.readEventShows?.nodes ?? [];
  return nodes.filter((n) => /opera/i.test(n.event.eventTypeName ?? ""));
}

const NAME_PARTICLES = new Set(["von", "van", "de", "da", "di", "del", "der", "le", "la", "den"]);

function isPersonName(text: string): boolean {
  if (!text || /^\d/.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((w) => {
    const bare = w.replace(/[.'’-]/g, "");
    if (!bare) return true;
    if (NAME_PARTICLES.has(bare.toLowerCase())) return true;
    return /^\p{Lu}/u.test(bare);
  });
}

function ogImage(html: string): string | null {
  return (
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1] ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)?.[1] ??
    null
  );
}
