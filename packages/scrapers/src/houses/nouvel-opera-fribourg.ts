import type { IsoDate } from "@opera-directory/schema";
import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";

/**
 * NOF — Nouvel Opéra Fribourg (`spielplan-html`) — a Fribourg company producing
 * new and chamber opera (often at Equilibre, Fribourg) alongside experimental
 * music-theatre, festivals and labs (all dropped). French site, custom CMS, plain
 * fetch (200 to the crawler UA, no proxy), no schema.org Event JSON-LD:
 *   - Production detail pages live at `/fr/productions/{season}/{slug}`; the home
 *     page links the current season and `/fr/productions/archives` lists the full
 *     back-catalogue (seasons 2019–20 onward) — walked in backfill mode.
 *   - Detail page: `<h1>` work title. **There is NO structured composer** — it is
 *     named only in the synopsis prose ("l'opéra d'Antonín Dvořák …"), so the
 *     composer is lifted from that "opéra de/d' {Name}" phrase (null when absent).
 *   - Credits sit in a `<table>` of `<td>label</td><td>names</td>` rows: French
 *     function labels (Direction musicale→conductor, Mise en scène→director,
 *     Scénographie→set-designer, Costumes→costume-designer, Lumières→lighting,
 *     Chorégraphie→choreographer …) map to the creative team; misc crew is
 *     dropped; every other row is a cast role (character → singer). The names cell
 *     can hold several `<br>`-separated performers (alternating casts, with date
 *     annotations stripped).
 *   - Performances are `<span>DD.MM.YY — HH:MM<br>{Venue}</span>` blocks.
 *   - Opera gate: a Mise en scène (director) credit AND a cast — drops the labs,
 *     brunches, festivals and competitions that share the programme.
 */

const BASE = "https://nof.ch";
const ARCHIVES = `${BASE}/fr/productions/archives`;

/** French creative-function keywords (substring-matched, since NOF combines them,
 *  e.g. "Scénographie, Costumes, Vidéo") → canonical function slug. First hit wins. */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/direction musicale|^direction$|chef d'orchestre/i, "conductor"],
  [/mise en scène/i, "director"],
  [/scénograph|décor/i, "set-designer"],
  [/costume/i, "costume-designer"],
  [/lumièr|éclairage/i, "lighting"],
  [/chorégraph/i, "choreographer"],
  [/chœur|choeur/i, "chorus-master"],
  [/dramaturg/i, "dramaturgy"],
];

/** Crew labels we don't model — dropped rather than mistaken for a cast role. */
const CREW_LABEL =
  /assistant|vidéo|video|surtitr|régie|^son$|technique|traduction|création|répétiteur|chef de chant|arrangement|orchestration|conception/i;

export async function scrapeNouvelOperaFribourg(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];
  const seen = new Set<string>();

  const pages = [`${BASE}/fr`];
  if (window.mode === "backfill") pages.push(ARCHIVES);

  const paths = new Set<string>();
  for (const page of pages) {
    try {
      const html = await fetchHtml(page, ctx);
      for (const [, path] of html.matchAll(/\/fr\/productions\/(\d{2}-\d{2}\/[a-z0-9-]+)/g)) {
        if (path) paths.add(path);
      }
    } catch (err) {
      console.warn(`nouvel-opera-fribourg: ${page} failed:`, err);
    }
  }

  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      const html = await fetchHtml(`${BASE}/fr/productions/${path}`, ctx);
      const prod = parseProduction(html, path);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`nouvel-opera-fribourg: production ${path} failed:`, err);
    }
  }

  return { house_slug: "nouvel-opera-fribourg", productions };
}

function parseProduction(html: string, path: string): RawProduction | null {
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  if (!title) return null;

  const { creative_team, cast } = parseCredits(html);
  // Opera gate: a staged work has a director + a cast. Labs/brunches/festivals/
  // competitions that share the programme have neither.
  if (cast.length === 0 || !creative_team.some((c) => c.function === "director")) return null;

  const performances = parsePerformances(html);
  if (performances.length === 0) return null;

  return {
    source_production_id: `nouvel-opera-fribourg/${path}`,
    work_title: title,
    composer_name: composerFromProse(html),
    detail_url: `${BASE}/fr/productions/${path}`,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances,
  };
}

/** Composer from the synopsis prose ("l'opéra de/d' {Name}"); null when absent. */
function composerFromProse(html: string): string | null {
  const m = stripHtml(html).match(
    /op[ée]ra d[e'’]\s*(\p{Lu}[\p{L}.'’-]+(?:\s+\p{Lu}[\p{L}.'’-]+){0,3})/u,
  );
  return m?.[1]?.trim() ?? null;
}

function ogImage(html: string): string | null {
  return (
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)?.[1] ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)?.[1] ??
    null
  );
}

/** `<table>` of `<td>label</td><td>names</td>` rows. Function labels → creative
 *  team (first performer), misc crew dropped, everything else → cast roles (each
 *  `<br>`-separated performer, date annotations stripped). */
function parseCredits(html: string): { creative_team: RawCredit[]; cast: RawCredit[] } {
  const creative_team: RawCredit[] = [];
  const cast: RawCredit[] = [];

  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(row ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
    if (cells.length < 2) continue;
    const label = stripHtml(cells[0]?.[1] ?? "");
    const names = performerNames(cells[1]?.[1] ?? "");
    if (!label || names.length === 0) continue;

    const fn = CREATIVE_FUNCTIONS.find(([re]) => re.test(label))?.[1];
    if (fn) {
      if (names[0]) creative_team.push({ function: fn, name: names[0] });
    } else if (!CREW_LABEL.test(label)) {
      for (const name of names) cast.push({ role: label, name });
    }
  }
  return { creative_team, cast };
}

/** A names cell holds one or more `<br>`-separated performers; strip the trailing
 *  date annotations NOF adds for alternating casts ("Bertille Monsellier 2 janvier
 *  2026" → "Bertille Monsellier"). */
function performerNames(cell: string): string[] {
  return cell
    .split(/<br\s*\/?>/i)
    .map((part) =>
      stripHtml(part)
        .replace(/\s+\d{1,2}\s+\p{L}+\s+20\d{2}.*$/u, "")
        .replace(/\s+\d{1,2}[./]\d{1,2}[./]\d{2,4}.*$/u, "")
        .trim(),
    )
    .filter((n) => n && !/^tbc$/i.test(n));
}

/** `<span>DD.MM.YY — HH:MM<br>{Venue}</span>` blocks → performances. */
function parsePerformances(html: string): RawPerformance[] {
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  const today = new Date().toISOString().slice(0, 10);

  for (const [, span] of html.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)) {
    const m = decodeEntities(span ?? "").match(
      /(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*[—–-]\s*(\d{1,2}):(\d{2})/,
    );
    if (!m) continue;
    const yy = m[3] ?? "";
    const year = yy.length === 2 ? 2000 + Number.parseInt(yy, 10) : Number.parseInt(yy, 10);
    const date =
      `${year}-${(m[2] ?? "").padStart(2, "0")}-${(m[1] ?? "").padStart(2, "0")}` as IsoDate;
    const time = `${(m[4] ?? "").padStart(2, "0")}:${m[5]}`;
    const venue = stripHtml((span ?? "").replace(/[\s\S]*<br\s*\/?>/i, "")) || null;
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, venue_room: venue, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}
