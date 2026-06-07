import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * Royal Swedish Opera / Kungliga Operan (`json-api` strategy) — Sweden's national
 * opera house in Stockholm, presenting opera + ballet. The live scrape is the
 * announced + currently-saleable season; `backfill` appends Wikidata for the deep
 * past. The site is SWEDISH; we prefer the English locale
 * (`/en/productions/{slug}`) so the credit labels are English, and fall back to
 * the Swedish page (`/forestallningar/{slug}`) when a production has no English
 * mirror (some Swedish-only stagings do). Both label sets are mapped to our
 * function slugs INSIDE this adapter (English + Swedish-fallback tables below).
 *
 * Umbraco CMS (server-rendered) fronting a separate ticketing API. A production
 * is a `/forestallningar/{slug}` page (English mirror `/en/productions/{slug}`),
 * enumerated from the site sitemap. Three sources combine per production:
 *   - The production page carries `data-production-page-pid="{pid}"`, an
 *     `og:title` genre token, and a "Music & creative team" accordion whose body
 *     pastes "LABEL Name" rows (often via Word-styled <span>s, so we flatten the
 *     block to plain text and split on the known labels). `Music`/`Musik` is the
 *     composer; the rest is the creative team.
 *   - `webapi.operan.se/performances?productionIds={pid}` returns the saleable
 *     performances (`performanceDate`, an offset ISO timestamp). The future leg.
 *   - `contentapi/en/people/forperformances?performanceIds=…` returns the cast
 *     (role = character name, always in Swedish); the choir/orchestra ensemble
 *     rows (role "Med") and the conductor (role "Dirigent", already taken from the
 *     accordion) are dropped, leaving sung roles.
 *
 * Opera gate (drops ballet/dance/concert/talks, which share /forestallningar):
 *   - a composer (Music) AND a Director credit — pure ballets credit a
 *     choreographer but no director; concerts/galas/guided tours credit neither;
 *   - and NOT an `og:title` ballet/musical genre token — catches the dance pieces
 *     that do carry a director (e.g. the Ballet's dance-theatre evenings).
 * An opera with incidental choreography (e.g. Karlsson's "Melancholia") keeps its
 * Director and carries no Ballet token, so it survives.
 */

const BASE = "https://www.operan.se";
const WEB_API = "https://webapi.operan.se";
const CONTENT_API = `${BASE}/contentapi/en`;

/** Royal Swedish Opera on Wikidata — the opera COMPANY (Q254283), not the theatre
 *  building (Q118463941). Verified via wbsearchentities: Q254283 = "Royal Swedish
 *  Opera", "opera company in Stockholm, Sweden" (alias "Kungliga Operan"). */
const WIKIDATA_QID = "Q254283";

/** English creative-team labels (the accordion's row labels) → our function slugs.
 *  The house prints combined labels (e.g. "Director, scenography and light");
 *  those map to the most specific function we model (director). A row whose label
 *  is unmapped is dropped rather than guessed. Longest labels are matched first so
 *  a combined "set & costume design" wins over a bare "costume design". */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  music: "composer",
  conductor: "conductor",
  director: "director",
  "director, scenography and light": "director",
  "director & libretto": "director",
  "director and libretto": "director",
  "set design": "set-designer",
  scenography: "set-designer",
  "set & costume design": "set-designer",
  "set and costume design": "set-designer",
  "costume design": "costume-designer",
  "costume & mask design": "costume-designer",
  "costume and mask design": "costume-designer",
  "costume design and makeup": "costume-designer",
  "light design": "lighting",
  "lighting design": "lighting",
  light: "lighting",
  choreography: "choreographer",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
  dramaturgy: "dramaturgy",
  // Swedish-fallback labels (the Swedish-only production pages).
  musik: "composer",
  dirigent: "conductor",
  regi: "director",
  "regi & libretto": "director",
  scenografi: "set-designer",
  "scenografi och kostym": "set-designer",
  "scenografi & kostym": "set-designer",
  kostym: "costume-designer",
  "kostym och mask": "costume-designer",
  ljus: "lighting",
  ljusdesign: "lighting",
  koreografi: "choreographer",
  körledare: "chorus-master",
  kördirigent: "chorus-master",
  kormästare: "chorus-master",
};

/** Ballet/dance/musical genre tokens in `og:title`, English and Swedish — an
 *  immediate disqualifier (catches dance-theatre evenings that credit a director). */
const NON_OPERA_GENRES = /[│|]\s*(ballet|balett|dans|musical|musikal)\s*[│|]/i;

/** Ensemble/conductor cast rows from the people API to drop. "Med" ("with") tags
 *  the choir/orchestra; "Dirigent" is the conductor, already read from the
 *  accordion as a creative credit. */
const NON_SINGER_ROLES = new Set(["med", "dirigent"]);

interface ApiPerformance {
  performanceId: number;
  productionId: number;
  performanceDate?: string;
}

interface ApiPersonPerformance {
  role?: string;
}

interface ApiPerson {
  name?: string;
  performances?: ApiPersonPerformance[];
}

export async function scrapeRoyalSwedishOpera(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  try {
    for (const slug of await collectSlugs(ctx)) {
      try {
        const prod = await scrapeProduction(slug, ctx, window);
        if (prod) productions.push(prod);
      } catch (err) {
        console.warn(`royal-swedish-opera: production ${slug} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("royal-swedish-opera: live scrape failed:", err);
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("royal-swedish-opera: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "royal-swedish-opera", productions };
}

/** Every production lives at `/forestallningar/{slug}` in the sitemap (the index
 *  the JS calendar reads is the saleable subset; the sitemap is the full set). */
async function collectSlugs(ctx: FetchContext): Promise<string[]> {
  const xml = await fetchHtml(`${BASE}/site-map.xml`, ctx);
  const slugs = new Set<string>();
  for (const [, slug] of xml.matchAll(/\/forestallningar\/([^<\s/]+)</g)) {
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

async function scrapeProduction(
  slug: string,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<RawProduction | null> {
  const page = await fetchProductionPage(slug, ctx);
  if (!page) return null;
  const { html, url } = page;

  const pid = html.match(/data-production-page-pid="(\d+)"/)?.[1];
  if (!pid) return null;

  const ogTitle = decodeEntities(
    html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? "",
  );
  if (NON_OPERA_GENRES.test(ogTitle)) return null;

  const { composer, creative_team } = parseCreative(html);
  if (!composer) return null;
  // A staged opera credits a director; pure ballets credit only a choreographer,
  // and concerts / galas / guided tours credit neither.
  if (!creative_team.some((c) => c.function === "director")) return null;

  const apiPerfs = await fetchJson<ApiPerformance[]>(
    `${WEB_API}/performances?productionIds=${pid}`,
    ctx,
  );
  const performances = parsePerformances(apiPerfs, window);
  if (performances.length === 0) return null;

  const cast = await fetchCast(
    apiPerfs.map((p) => p.performanceId),
    ctx,
  );

  const title = stripHtml(
    html.match(/<h1[^>]*class="production-hero__title"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "",
  );

  return {
    source_production_id: `royal-swedish-opera/${pid}`,
    work_title: title || ogTitleWork(ogTitle) || slug,
    composer_name: composer,
    detail_url: url,
    creative_team,
    cast,
    performances,
  };
}

/** Prefer the English page; fall back to the Swedish one for productions with no
 *  English mirror. A 404 on both means the sitemap slug has no detail page (some
 *  campaign / archive slugs) — return null without noise. */
async function fetchProductionPage(
  slug: string,
  ctx: FetchContext,
): Promise<{ html: string; url: string } | null> {
  for (const url of [`${BASE}/en/productions/${slug}`, `${BASE}/forestallningar/${slug}`]) {
    try {
      return { html: await fetchHtml(url, ctx), url };
    } catch {
      // Try the next locale; a genuine miss falls through to null.
    }
  }
  return null;
}

/** Flatten the "Music & creative team" accordion to plain text, then split it into
 *  "LABEL value" rows on the known labels (English or Swedish; the body is pasted
 *  from Word with nested styling spans, so tag-relative parsing is unreliable). */
function parseCreative(html: string): { composer: string | null; creative_team: RawCredit[] } {
  const block = creativeBlock(html);
  if (!block) return { composer: null, creative_team: [] };

  const text = decodeEntities(
    block
      .replace(/<br[^>]*>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ");

  const labels = Object.keys(CREATIVE_FUNCTIONS).sort((a, b) => b.length - a.length);
  const rowRe = new RegExp(`^\\s*(${labels.map(escapeRe).join("|")})\\s+(.+)$`, "i");

  let composer: string | null = null;
  const creative_team: RawCredit[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(rowRe);
    if (!m) continue;
    const fn = CREATIVE_FUNCTIONS[(m[1] ?? "").toLowerCase()];
    const value = (m[2] ?? "").trim();
    if (!fn || !value) continue;
    if (fn === "composer") {
      composer = composer ?? value;
      continue;
    }
    for (const name of splitNames(value)) {
      const key = `${fn}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creative_team.push({ function: fn, name });
    }
  }
  return { composer, creative_team };
}

/** The accordion whose title flags the creative team — English or Swedish. */
function creativeBlock(html: string): string | null {
  for (const m of html.matchAll(
    /<a class="uk-accordion-title"[^>]*>([\s\S]*?)<\/a>\s*<div class="uk-accordion-content">([\s\S]*?)<\/div>/g,
  )) {
    const title = stripHtml(m[1] ?? "").toLowerCase();
    if (/creative|music|team|musik|kreativt/.test(title)) return m[2] ?? null;
  }
  return null;
}

/** Performances are the saleable nights; each `performanceDate` is an offset ISO
 *  timestamp. Honors window.since; the venue is the house, with no sub-room split. */
function parsePerformances(perfs: ApiPerformance[], window: ScrapeWindow): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();

  for (const p of perfs) {
    const m = (p.performanceDate ?? "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (!m) continue;
    const date = m[1] as IsoDate;
    const time = m[2] ?? null;
    if (window.since && date < window.since) continue;
    const key = `${date}|${time ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

/** Cast (sung roles) for a production's performances, deduped across the run. The
 *  role is the character name as printed; ensemble and conductor rows are dropped. */
async function fetchCast(performanceIds: number[], ctx: FetchContext): Promise<RawCredit[]> {
  if (performanceIds.length === 0) return [];
  const query = performanceIds.map((id) => `performanceIds=${id}`).join("&");
  const people = await fetchJson<ApiPerson[]>(
    `${CONTENT_API}/people/forperformances?${query}`,
    ctx,
  );

  const cast: RawCredit[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    const name = stripHtml(person.name ?? "");
    if (!name) continue;
    for (const pp of person.performances ?? []) {
      const role = stripHtml(pp.role ?? "");
      if (!role || NON_SINGER_ROLES.has(role.toLowerCase())) continue;
      const key = `${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cast.push({ role, name });
    }
  }
  return cast;
}

/** A row value can hold alternating casts separated by "/" or line breaks. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*\/\s*|\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The leading segment of an `og:title` ("Carmen │ Opera │ …") as a title fallback. */
function ogTitleWork(ogTitle: string): string | null {
  const head = ogTitle.split(/[│|]/)[0]?.trim();
  return head || null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
