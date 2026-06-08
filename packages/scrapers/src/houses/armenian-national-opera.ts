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
 * Armenian National Opera and Ballet Theatre (`spielplan-html`) — A. Spendiaryan
 * National Academic Theatre, Yerevan. WordPress front (opera.am/public/en) +
 * separate ticketing host (ticket.opera.am), plain fetch (no proxy):
 *   - Discovery: the repertoire page (`/public/en/repertoire`) is a grid of
 *     performance cards — each `<div class="item">` links a single dated show to
 *     `ticket.opera.am/en/details/{id}/{Composer “TITLE”}` and prints the day
 *     (`p.date-s`), month and start time. The link text carries the composer + work
 *     title; cards are grouped into productions by (composer + title).
 *   - Genre + creative team come from the ticket detail page, which states the form
 *     ("Opera in 4 acts" / "Ballet in 2 acts" — the opera filter) and a `{Label}:
 *     {Name} /honorific/` credit block (Musical director and conductor / Stage
 *     director / Set designer …). No singer cast is published, so productions carry
 *     creative + dates only.
 *   - No year is printed on the cards → inferred forward from today.
 *   - Opera gate: ticket-page genre "Opera" (not Ballet/Concert) AND a person-name
 *     composer. Concerts/galas (no composer in the link) never enter.
 */

const REPERTOIRE = "https://opera.am/public/en/repertoire";

const EN_MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** English creative-function labels → canonical function slugs (substring-matched). */
const CREATIVE_FUNCTIONS: [RegExp, string][] = [
  [/conductor|musical director/i, "conductor"],
  [/chorus master|choir master/i, "chorus-master"],
  [/choreograph/i, "choreographer"],
  [/stage director|^director|direction/i, "director"],
  [/set designer|scenograph/i, "set-designer"],
  [/costume/i, "costume-designer"],
  [/light/i, "lighting"],
  [/dramaturg/i, "dramaturg"],
];

interface Card {
  id: string;
  href: string;
  composer: string;
  title: string;
  perf: RawPerformance;
}

export async function scrapeArmenianNationalOpera(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const productions: RawProduction[] = [];

  let groups: Map<string, { composer: string; title: string; href: string; perfs: RawPerformance[] }>;
  try {
    const html = await fetchHtml(REPERTOIRE, ctx);
    groups = groupCards(parseCards(html));
  } catch (err) {
    console.warn("armenian-national-opera: repertoire fetch failed:", err);
    return { house_slug: "armenian-national-opera", productions };
  }

  for (const [key, g] of groups) {
    try {
      const detail = await fetchHtml(g.href, ctx);
      // The form is stated in EN or RU ("Opera in 3 acts" / "Опера в 3-х действиях").
      // Keep only an explicit opera statement; ballet/concert and the productions
      // with no stated form at all are dropped (can't confirm they're opera).
      const isOpera = /\bopera\s+in\s+\d|опера\s+в\s+\d/i.test(detail);
      const isBallet = /\bballet\s+in\s+\d|балет\s+в\s+\d/i.test(detail);
      if (!isOpera || isBallet) continue;
      const creative_team = parseCreative(detail);
      if (!isPersonName(g.composer)) continue;

      productions.push({
        source_production_id: `armenian-national-opera/${key}`,
        work_title: g.title,
        composer_name: g.composer,
        detail_url: g.href,
        creative_team,
        cast: [],
        performances: g.perfs.sort(
          (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
        ),
      });
    } catch (err) {
      console.warn(`armenian-national-opera: ${g.title} failed:`, err);
    }
  }

  return { house_slug: "armenian-national-opera", productions };
}

/** Repertoire grid cards → one dated performance each, with the composer + title
 *  pulled from the ticket link text ("{Composer} “{Title}”"). */
function parseCards(html: string): Card[] {
  const now = new Date();
  const curMonth = now.getMonth() + 1;
  const today = now.toISOString().slice(0, 10);
  const cards: Card[] = [];
  for (const item of html.split(/class="item"/).slice(1)) {
    const link = item.match(/(https:\/\/ticket\.opera\.am\/en\/details\/(\d+)\/([^"]+))"/);
    if (!link) continue;
    const text = decodeEntities(link[3] ?? "").trim();
    const m = text.match(/^\s*(.+?)\s*[“"«](.+?)[”"»]/);
    if (!m) continue; // no composer/title quotes → gala/concert, skip
    const dm = item.match(/class="date-s">\s*(\d{1,2})\s*<\/p>\s*<p[^>]*>\s*([A-Za-z]+)/);
    if (!dm) continue;
    const month = EN_MONTHS[(dm[2] ?? "").slice(0, 3).toLowerCase()];
    if (!month) continue;
    const day = Number.parseInt(dm[1] ?? "", 10);
    const year = month >= curMonth ? now.getFullYear() : now.getFullYear() + 1;
    const date = iso(year, month, day);
    const time = item.match(/\b(\d{2}:\d{2})\b/)?.[1] ?? null;
    cards.push({
      id: link[2] ?? "",
      href: `https://ticket.opera.am/en/details/${link[2]}/${encodeURIComponent(text)}`,
      // Composer is abbreviated and sometimes lacks the space ("A.Tigranyan");
      // restore it so the initial + surname reads as two name words.
      composer: stripHtml(m[1] ?? "").replace(/(\p{Lu}\.)(?=\p{Lu})/gu, "$1 "),
      title: stripHtml(m[2] ?? ""),
      perf: { date, time, status: date < today ? "past" : "scheduled" },
    });
  }
  return cards;
}

function groupCards(
  cards: Card[],
): Map<string, { composer: string; title: string; href: string; perfs: RawPerformance[] }> {
  const groups = new Map<
    string,
    { composer: string; title: string; href: string; perfs: RawPerformance[] }
  >();
  for (const c of cards) {
    const key = `${c.composer}-${c.title}`
      .toLowerCase()
      .replace(/[^a-z0-9Ѐ-׿]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const g = groups.get(key) ?? { composer: c.composer, title: c.title, href: c.href, perfs: [] };
    if (!g.perfs.some((p) => p.date === c.perf.date && p.time === c.perf.time)) g.perfs.push(c.perf);
    groups.set(key, g);
  }
  return groups;
}

/** The English credit lines `{Label}: {Name} /honorific/`, which appear either as
 *  separate `<p>`s or `<br>`-joined — so they're scanned globally by their label
 *  (the name runs to the next tag or the trailing "/honorific/"). Russian-described
 *  productions carry no English labels and yield an empty (acceptable) team. */
function parseCreative(html: string): RawCredit[] {
  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /(Musical director and conductor|Stage director|Set designer|Costume designer|Choreographer|Chorus ?master|Lighting designer|Conductor|Director)\s*:\s*([^<\/]+)/gi,
  )) {
    const fn = CREATIVE_FUNCTIONS.find(([re]) => re.test(m[1] ?? ""))?.[1];
    if (!fn) continue;
    const name = stripHtml(m[2] ?? "")
      .replace(/\s*\/.*$/, "")
      .trim();
    if (!isPersonName(name)) continue;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ function: fn, name });
  }
  return out;
}

const NAME_PARTICLES = new Set(["von", "van", "de", "da", "di", "del", "der", "le", "la", "den"]);

/** Accepts Latin OR Armenian names; the composer is often abbreviated ("G. Bizet"). */
function isPersonName(text: string): boolean {
  if (!text || /^\d/.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((w) => {
    const bare = w.replace(/[.'’-]/g, "");
    if (!bare) return true;
    if (NAME_PARTICLES.has(bare.toLowerCase())) return true;
    return /^\p{Lu}/u.test(bare); // \p{Lu} covers Armenian capital letters too
  });
}

function iso(y: number, m: number, d: number): IsoDate {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` as IsoDate;
}
