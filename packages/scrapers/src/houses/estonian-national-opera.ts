import { decodeEntities, type FetchContext, fetchHtml, stripHtml } from "../fetch";
import type {
  HouseScrapeResult,
  RawCredit,
  RawPerformance,
  RawProduction,
  ScrapeWindow,
} from "../types";
import { isoFromParts } from "./_dates";

/**
 * Estonian National Opera (`spielplan-html`) — Rahvusooper Estonia, Tallinn (opera
 * & ballet). Thorgate/Django CMS with a full English /en/ mirror, plain fetch (200
 * to the crawler UA, no proxy), no schema.org Event JSON-LD:
 *   - Discovery: the opera category page (`/en/stagings/opera/`) links the live
 *     repertoire as `/en/staging/{slug}/` detail pages — but it still mixes in some
 *     ballet, so the genre is read off each detail page's subtitle h3 and only opera
 *     is kept.
 *   - Detail page: `<h1>` work title; the subtitle h3 carries both genre and
 *     composer in two phrasings ("Opera by {X}" / "{X}'s opera"). Creative team =
 *     the structured `<ul aria-label="Creative team">` cards (`<p id="role-N">
 *     {label}</p>` + `<h3><a href="/en/person/…">{Name}</a></h3>`, English labels
 *     substring-mapped). Cast = the prose block after "Cast:" — `{Role}:
 *     <strong>{Name}</strong>, … <br>` lines (alternating casts comma-separated,
 *     country tags in parens dropped; all kept at production level).
 *   - Performances: hidden `<div class="d-none">{Weekday}, {D}. {Month} {YYYY}
 *     {HH:MM}</div>` rows — full ISO dates, the announced future.
 *   - Opera gate: subtitle genre "opera" (not ballet) AND a person-name composer
 *     AND (a cast list OR a director credit).
 */

const BASE = "https://www.opera.ee";

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

/** English creative-function labels → canonical function slugs (substring-matched,
 *  first hit wins). Assistants / orchestra leaders / repetiteurs are skipped. */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/conductor|music director/i, "conductor"],
  [/choir ?master|chorus master/i, "chorus-master"],
  [/choreograph/i, "choreographer"],
  [/stage director|director$/i, "director"],
  [/set|scenograph|designer$/i, "set-designer"],
  [/costume/i, "costume-designer"],
  [/light/i, "lighting"],
  [/dramaturg/i, "dramaturgy"],
];

export async function scrapeEstonianNationalOpera(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let urls: string[];
  try {
    const index = await fetchHtml(`${BASE}/en/stagings/opera/`, ctx);
    urls = [
      ...new Set(
        [...index.matchAll(/href="(\/en\/staging\/[^"]+)"/g)].map((m) => `${BASE}${m[1]}`),
      ),
    ];
  } catch (err) {
    console.warn("estonian-national-opera: listing fetch failed:", err);
    return { house_slug: "estonian-national-opera", productions };
  }

  for (const url of urls) {
    try {
      const html = await fetchHtml(url, ctx);
      const prod = parseProduction(html, url);
      if (prod) productions.push(prod);
    } catch (err) {
      console.warn(`estonian-national-opera: ${url} failed:`, err);
    }
  }

  return { house_slug: "estonian-national-opera", productions };
}

function parseProduction(html: string, url: string): RawProduction | null {
  const gc = genreComposer(html);
  if (!gc?.opera) return null; // opera/operetta only — drops ballet

  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const composer = gc.composer;
  if (!title || !isPersonName(composer)) return null;

  const creative_team = parseTeam(html);
  const cast = parseCast(html);
  if (cast.length === 0 && !creative_team.some((c) => c.function === "director")) return null;

  const slug = url.match(/\/staging\/([^/]+)\//)?.[1] ?? url;
  return {
    source_production_id: `estonian-national-opera/${slug}`,
    work_title: title,
    composer_name: composer,
    detail_url: url,
    image_url: ogImage(html),
    creative_team,
    cast,
    performances: parsePerformances(html),
  };
}

/** The genre + composer descriptor, which sits in varying tags across pages
 *  ("[Comic] opera by {Composer}" or possessive "{Composer}'s [romantic] opera").
 *  Returns the first reading whose composer is a real person name. */
function genreComposer(html: string): { opera: boolean; composer: string } | null {
  for (const m of html.matchAll(
    /\b(opera|operetta|ballet)\b[^<]{0,20}?\bby\s+([^<(,\n]{2,45})/gi,
  )) {
    const composer = stripHtml(m[2] ?? "").trim();
    if (isPersonName(composer)) return { opera: !/ballet/i.test(m[1] ?? ""), composer };
  }
  for (const m of html.matchAll(
    /([A-ZÀ-Ý][^<(,\n]{2,40}?)[''’]s\s+(?:[a-zà-ÿ-]+\s+)?(opera|operetta|ballet)\b/g,
  )) {
    const composer = stripHtml(m[1] ?? "").trim();
    if (isPersonName(composer)) return { opera: !/ballet/i.test(m[2] ?? ""), composer };
  }
  return null;
}

/** Structured `<ul aria-label="Creative team">` cards: each `<li>` pairs a
 *  `<p id="role-N">{label}</p>` with one or more `/en/person/` artist links. */
function parseTeam(html: string): RawCredit[] {
  const block = html.match(/aria-label="Creative team">([\s\S]*?)<\/ul>/)?.[1] ?? "";
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const li of block.matchAll(/<li[\s\S]*?<\/li>/g)) {
    const html_li = li[0];
    const label = stripHtml(html_li.match(/id="role-\d+"[^>]*>([^<]+)</)?.[1] ?? "");
    const fn = CREATIVE_FUNCTIONS.find(([re]) => re.test(label))?.[1];
    if (!fn || /assistant|repetiteur|concert ?master|stage manager/i.test(label)) continue;
    for (const a of html_li.matchAll(/\/en\/person\/[^"]*"[^>]*>([^<]+)<\/a>/g)) {
      const name = stripHtml(a[1] ?? "");
      const key = `${fn}|${name}`;
      if (isPersonName(name) && !seen.has(key)) {
        seen.add(key);
        out.push({ function: fn, name });
      }
    }
  }
  return out;
}

/** Cast from two sources, merged + deduped: the structured "Performers" cards
 *  (`<a aria-label="{Name} - {Role}">`, present when no prose list is) and the
 *  prose block after "Cast:" — `{Role}: <strong>{Name}</strong>, … <br>` lines
 *  (alternating casts comma-separated, country tags in parens dropped). */
function parseCast(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  const add = (role: string, name: string) => {
    const r = role.replace(/[:\s]+$/, "").trim();
    if (!r || !/^\p{L}/u.test(r) || /chorus|orchestra|ballet|ensemble|^cast$/i.test(r)) return;
    if (!isPersonName(name)) return;
    const key = `${r}|${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ role: r, name });
  };

  const cards = html.match(/performers__cells[\s\S]*?<\/ul>/)?.[0] ?? "";
  for (const a of cards.matchAll(/aria-label="([^"]+?)\s+-\s+([^"]+?)"/g)) {
    add(stripHtml(a[2] ?? ""), stripHtml(a[1] ?? ""));
  }

  const start = html.indexOf("Cast:");
  if (start >= 0) {
    const ct = html.indexOf('aria-label="Creative team"', start);
    const block = html.slice(start, ct < 0 ? start + 4000 : ct);
    for (const line of block.split(/<br\s*\/?>/i)) {
      const role = stripHtml(line.split(/<strong/i)[0] ?? "");
      for (const s of line.matchAll(/<strong>([\s\S]*?)<\/strong>/g)) {
        for (const part of stripHtml(s[1] ?? "").split(",")) {
          add(role, part.replace(/\s*\([^)]*\)\s*/g, "").trim());
        }
      }
    }
  }
  return out;
}

/** Hidden `<div class="d-none">{Weekday}, {D}. {Month} {YYYY} {HH:MM}</div>` rows. */
function parsePerformances(html: string): RawPerformance[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: RawPerformance[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /class="d-none">[^,<]*,\s*(\d{1,2})\.\s*([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}:\d{2})/g,
  )) {
    const month = EN_MONTHS[(m[2] ?? "").toLowerCase()];
    if (!month) continue;
    const date = isoFromParts(
      Number.parseInt(m[3] ?? "", 10),
      month,
      Number.parseInt(m[1] ?? "", 10),
    );
    if (!date) continue;
    const time = m[4] ?? null;
    const key = `${date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, time, status: date < today ? "past" : "scheduled" });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}

const NAME_PARTICLES = new Set([
  "von",
  "van",
  "de",
  "da",
  "di",
  "del",
  "della",
  "der",
  "le",
  "la",
  "den",
]);

function isPersonName(text: string): boolean {
  const t = decodeEntities(text);
  if (!t || /^\d/.test(t)) return false;
  const words = t.split(/\s+/);
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
