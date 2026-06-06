import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Savonlinna Opera Festival (`spielplan-html` strategy) — the Finnish summer
 * opera festival staged in the medieval Olavinlinna castle (~July). A FESTIVAL:
 * one edition at a time, summer-only → the live scrape is the CURRENT edition's
 * staged opera; `backfill` appends Wikidata (currently empty for this QID — the
 * festival's past stagings aren't modeled there, so live is the only source).
 *
 * WordPress + Elementor behind WPML. The English locale lives under `/en/`, with
 * Finnish-slugged URLs (`/en/ohjelmisto/{slug}/` = "programme"); we parse the
 * English site so the credit labels are English, not the hard Finnish terms. No
 * schema.org Event JSON-LD, so everything is parsed from HTML:
 *   - The season hub `/en/season-2026/` links to each opera's `/en/ohjelmisto/
 *     {slug}/` page (the year is read from the page's performance dates, so the
 *     hub URL is resolved from the homepage's seasonal link rather than hardcoded).
 *   - The detail page carries the title in `<h1 class="entry-title">` and the
 *     composer in `<h2 class="entry-sub-title">` (the byline directly under it).
 *   - Performances sit in `<ul class="event-schedule">` as `<div class="showtime">
 *     DD.MM.YYYY klo HH:MM</div>` (Finnish date order; "klo" = "at").
 *   - The "Team" `<section class="table-info">` lists `<li class="table-row">` of
 *     `row-title` (function) / `row-content` (name); English labels are mapped
 *     INSIDE this adapter. An ensemble row (orchestra/choir) carries no row-title
 *     and is dropped. Cast sits in `<div class="artist-info">` blocks pairing
 *     `artist-name` (singer) with `character-name` (role + a trailing date list).
 *   - A staged opera always credits a Director; the festival also programmes
 *     concert versions of operas (e.g. "Norma" 2026, conductor only) and guest
 *     galas — the Director credit is the filter that keeps staged opera only.
 */

const BASE = "https://operafestival.fi";

/** Savonlinna Opera Festival on Wikidata. Verified via wbsearchentities:
 *  Q917300 = "Savonlinna Opera Festival", "annual music festival in Savonlinna,
 *  Finland". (Backfill yields nothing today — no productions are linked to it —
 *  but the call is kept so coverage lands automatically if Wikidata fills in.) */
const WIKIDATA_QID = "Q917300";

/** English creative-team labels → our canonical function slugs. The site prints a
 *  few variants ("Director" / "Stage director", "Set and costume designer", and a
 *  recurring "Lightning designer" typo for Lighting). Fold them here; a row whose
 *  label is unmapped is not emitted as a credit. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  conductor: "conductor",
  director: "director",
  "stage director": "director",
  "set designer": "set-designer",
  "scenic designer": "set-designer",
  "set and costume designer": "set-designer",
  "set & costume designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "lightning designer": "lighting",
  "video designer": "video-designer",
  choreographer: "choreographer",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
  dramaturgy: "dramaturgy",
};

export async function scrapeSavonlinnaOperaFestival(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    const slugs = await collectProgrammeSlugs(ctx);
    for (const slug of slugs) {
      try {
        const html = await fetchHtml(`${BASE}/en/ohjelmisto/${slug}/`, ctx);
        const prod = parseProduction(html, slug);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`savonlinna-opera-festival: programme ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("savonlinna-opera-festival: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("savonlinna-opera-festival: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "savonlinna-opera-festival", productions };
}

/** The homepage and the season hub both list the current edition's programme
 *  pages; the homepage is the stable entry point (the hub URL changes per year),
 *  so collect `/en/ohjelmisto/{slug}/` links from it. */
async function collectProgrammeSlugs(ctx: FetchContext): Promise<string[]> {
  const slugs = new Set<string>();
  const html = await fetchHtml(`${BASE}/en/`, ctx);
  for (const [, slug] of html.matchAll(
    /href="https:\/\/operafestival\.fi\/en\/ohjelmisto\/([^"/]+)\/"/g,
  )) {
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

function parseProduction(html: string, slug: string): RawProduction | null {
  const title = stripHtml(
    html.match(/<h1[^>]*class="entry-title"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "",
  );
  const composer = stripHtml(
    html.match(/class="[^"]*entry-sub-title"[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "",
  );
  if (!title || !composer) return null;

  const { creative_team, cast } = parseCredits(html);
  // Staged opera always credits a Director; concert versions of operas and guest
  // galas (a conductor only) do not. This is the opera filter.
  if (!creative_team.some((c) => c.function === "director")) return null;

  const performances = parsePerformances(html);
  if (performances.length === 0) return null;

  return {
    source_production_id: `savonlinna/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: `${BASE}/en/ohjelmisto/${slug}/`,
    creative_team,
    cast,
    performances,
  };
}

function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];
  const seen = new Set<string>();

  const teamBlock = html.match(/<h2[^>]*class="block-title"[^>]*>\s*Team[\s\S]*?<\/ul>/)?.[0] ?? "";
  for (const m of teamBlock.matchAll(/<li class="table-row">([\s\S]*?)<\/li>/g)) {
    const row = m[1] ?? "";
    const label = stripHtml(row.match(/class="row-title">([\s\S]*?)<\/div>/)?.[1] ?? "");
    // An ensemble row (orchestra/choir) has no row-title — skip it.
    if (!label) continue;
    const fn = CREATIVE_FUNCTIONS[label.toLowerCase()];
    if (!fn) continue;
    for (const name of splitNames(row.match(/class="row-content">([\s\S]*?)<\/div>/)?.[1] ?? "")) {
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    }
  }

  for (const m of html.matchAll(/<div class="artist-info">([\s\S]*?)<\/div>/g)) {
    const block = m[1] ?? "";
    const name = cleanName(block.match(/class="artist-name">([\s\S]*?)<\/h5>/)?.[1] ?? "");
    if (!name) continue;
    const role = stripRoleDates(
      stripHtml(block.match(/class="character-name">([\s\S]*?)<\/h6>/)?.[1] ?? ""),
    );
    const key = `cast|${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cast.push({ role: role || null, name });
  }

  return { creative_team, cast };
}

/** "27.7.2026 klo 19:00" (Finnish DD.MM.YYYY, "klo" = "at") → ISO date + HH:MM. */
function parsePerformances(html: string): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const sm of html.matchAll(/<div class="showtime">([^<]+)<\/div>/g)) {
    const m = (sm[1] ?? "").match(
      /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*klo\s*(\d{1,2})[:.](\d{2}))?/,
    );
    if (!m) continue;
    const [, d, mo, y, h, min] = m;
    const date = `${y}-${(mo ?? "").padStart(2, "0")}-${(d ?? "").padStart(2, "0")}` as IsoDate;
    const time = h ? `${h.padStart(2, "0")}:${min ?? "00"}` : null;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, status: status(date) });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** A row-content can hold several names on separate lines (alternating casts). */
function splitNames(content: string): string[] {
  return decodeEntities(content.replace(/<br\s*\/?>/gi, "\n"))
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Roles carry a trailing performance-date qualifier ("Violetta 27. & 30.7."):
 *  strip it so the bare role name resolves. */
function stripRoleDates(role: string): string {
  return role.replace(/\s+\d{1,2}\.[\s\S]*$/, "").trim();
}

function cleanName(raw: string): string {
  return stripHtml(decodeEntities(raw))
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

function status(date: IsoDate): RawPerformance["status"] {
  return date < new Date().toISOString().slice(0, 10) ? "past" : "scheduled";
}
