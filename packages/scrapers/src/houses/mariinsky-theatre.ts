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
 * Mariinsky Theatre, St Petersburg (`spielplan-html` strategy) — Russia's
 * leading opera + ballet company (Valery Gergiev), performing across the
 * historic Mariinsky Theatre, Mariinsky II, and the Concert Hall. Tier-1
 * international house.
 *
 * The site is Russian-first; we scrape the English mirror (`/en/`) throughout,
 * so the English credit/cast labels are primary and a small Russian fallback map
 * (RU_CREATIVE_FUNCTIONS) covers any blocks that haven't been translated.
 * `composerFromText` (German-only) is deliberately unused.
 *
 * The site is multi-genre (opera + ballet + operetta + concerts), so the whole
 * adapter is gated to OPERA by the genre byline: each production detail page
 * carries a `podtip1` caption reading "opera by {Composer}" / "ballet by
 * {Composer}" / "operetta by …" / Russian "опера …". ONLY an "opera"/"опера"
 * byline passes — ballet/operetta/concert and the byline-less academy galas drop.
 * The trailing name is both the opera gate and the composer (no composer ⇒ not an
 * opera). A bare "Music by …" credit line is NOT used as a fallback: ballets and
 * galas carry it too, so it would re-admit the very rows the byline filters out.
 *
 * Discovery is the playbill index (`/en/playbill/playbill/`), a self-listing grid
 * of every announced night. Each night links to a per-performance detail page
 * (`/en/playbill/playbill/{Y}/{M}/{D}/{n}_{HHMM}/`) whose URL encodes the date and
 * 24h time — the authoritative date source (the page body lists sibling nights
 * inline, so the URL is parsed instead). Many nights share one production; we
 * group them by the production's stable image-folder slug (e.g.
 * `opera_repertoire2014/skazkaotsaresalt`), falling back to the work title.
 *
 * Per detail page:
 *   - Title — the `<title>`.
 *   - Composer + opera gate — the `podtip1` byline (see gate note above).
 *   - Venue room — the `itemprop="location"` city-prefixed string, city stripped
 *     ("St Petersburg, Mariinsky II" → "Mariinsky II").
 *   - Credits — the `avtori` block's "Label: Name" lines (Musical Director, Stage
 *     Director, Set/Costume/Lighting Designer, Principal Chorus Master …) mapped
 *     to our function slugs in-adapter.
 *   - Cast — the `sostav` block's Conductor + "Role: Singer" lines.
 *   - Production-premiere date — the "Premiere of this production" line.
 *
 * `backfill` additionally appends Wikidata premieres for the deep past the live
 * playbill (current repertoire only) doesn't reach.
 */

const BASE = "https://www.mariinsky.ru";
const PLAYBILL_INDEX = `${BASE}/en/playbill/playbill/`;

/** Mariinsky Theatre on Wikidata — the opera COMPANY (Q207028), not the building's
 *  second stage (Q4127964), concert hall (Q4231897), orchestra (Q4419936), or the
 *  2008 film (Q48673896). Verified via wbsearchentities: Q207028 = "Mariinsky
 *  Theatre", description "opera company in Saint Petersburg, Russia". It carries
 *  P4647 (location of first performance) links — 26 premieres — so the Wikidata
 *  backfill is non-empty. */
const WIKIDATA_QID = "Q207028";

/** English creative-team labels → our canonical function slugs. An unmapped label
 *  is dropped rather than guessed. */
const CREATIVE_FUNCTIONS: Record<string, string> = {
  "musical director": "conductor",
  conductor: "conductor",
  "stage director": "director",
  director: "director",
  "director and choreographer": "director",
  "set designer": "set-designer",
  "set and costume designer": "set-designer",
  "production designer": "set-designer",
  "costume designer": "costume-designer",
  "lighting designer": "lighting",
  "video designer": "video-designer",
  "video projection": "video-designer",
  choreographer: "choreographer",
  choreography: "choreographer",
  "principal chorus master": "chorus-master",
  "chorus master": "chorus-master",
  dramaturg: "dramaturgy",
};

/** Russian creative-team labels → our canonical function slugs, for any block the
 *  English mirror leaves untranslated. */
const RU_CREATIVE_FUNCTIONS: Record<string, string> = {
  дирижёр: "conductor",
  дирижер: "conductor",
  "музыкальный руководитель": "conductor",
  режиссёр: "director",
  режиссер: "director",
  "режиссёр-постановщик": "director",
  "режиссер-постановщик": "director",
  сценография: "set-designer",
  "художник-постановщик": "set-designer",
  костюмы: "costume-designer",
  "художник по костюмам": "costume-designer",
  свет: "lighting",
  "художник по свету": "lighting",
  хормейстер: "chorus-master",
  "главный хормейстер": "chorus-master",
  хореография: "choreographer",
};

export async function scrapeMariinskyTheatre(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const byProduction = new Map<string, RawProduction>();

  try {
    for (const link of await collectPerformanceLinks(ctx)) {
      try {
        await ingestPerformance(byProduction, link, ctx, window);
      } catch (err) {
        console.warn(`mariinsky-theatre: performance ${link.path} failed:`, err);
      }
    }
  } catch (err) {
    console.warn("mariinsky-theatre: live scrape failed:", err);
  }

  for (const prod of byProduction.values()) {
    prod.performances.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
  }
  const productions = [...byProduction.values()].filter((p) => p.performances.length > 0);

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("mariinsky-theatre: wikidata backfill failed:", err);
    }
  }

  return { house_slug: "mariinsky-theatre", productions };
}

interface PerformanceLink {
  path: string;
  date: IsoDate;
  time: string | null;
}

/** Pull the per-performance detail links from the playbill index. Each URL encodes
 *  the night's date + 24h time (`/{Y}/{M}/{D}/{n}_{HHMM}/`) — parsed here as the
 *  authoritative date source so we never trust the body's inline sibling list. */
async function collectPerformanceLinks(ctx: FetchContext): Promise<PerformanceLink[]> {
  const html = await fetchHtml(PLAYBILL_INDEX, ctx);
  const seen = new Set<string>();
  const out: PerformanceLink[] = [];
  for (const [, path, y, mo, d, hhmm] of html.matchAll(
    /href="(\/en\/playbill\/playbill\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/\d+_(\d{3,4})\/?)"/g,
  )) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const date = `${y}-${pad(Number(mo))}-${pad(Number(d))}` as IsoDate;
    out.push({ path, date, time: parseUrlTime(hhmm) });
  }
  return out;
}

/** Fetch one night's detail page, opera-gate it, and fold its performance into the
 *  production accumulator (keyed by the stable image-folder slug, work-title
 *  fallback). Honors window.since. */
async function ingestPerformance(
  byProduction: Map<string, RawProduction>,
  link: PerformanceLink,
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<void> {
  if (window.since && link.date < window.since) return;

  const html = await fetchHtml(`${BASE}${link.path}`, ctx);

  const composer = parseComposer(html);
  // No "opera by {Composer}" byline ⇒ ballet / concert / non-opera. Opera gate.
  if (!composer) return;

  const title = parseTitle(html);
  if (!title) return;

  const today = new Date().toISOString().slice(0, 10);
  const performance: RawPerformance = {
    date: link.date,
    time: link.time,
    venue_room: parseVenue(html),
    status: link.date < today ? "past" : "scheduled",
  };

  const key = productionKey(html, title);
  const existing = byProduction.get(key);
  if (existing) {
    if (!existing.performances.some((p) => p.date === link.date && p.time === link.time)) {
      existing.performances.push(performance);
    }
    return;
  }

  byProduction.set(key, {
    source_production_id: `mariinsky-theatre/${key}`,
    work_title: title,
    composer_name: composer,
    premiere_date: parseProductionPremiere(html),
    detail_url: `${BASE}${link.path}`,
    image_url: parseImage(html),
    synopsis: parseSynopsis(html),
    creative_team: parseCreative(html),
    cast: parseCast(html),
    performances: [performance],
  });
}

/** Stable per-production key: the image-folder slug
 *  (`opera_repertoire2014/skazkaotsaresalt`), which is shared by every night of a
 *  production. Falls back to the normalized work title when no image is present. */
function productionKey(html: string, title: string): string {
  const slug = html.match(/\/images\/cms\/data\/([a-z0-9_]+_repertoire\d*\/[a-z0-9_]+)\//i)?.[1];
  return (
    slug ??
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

function parseTitle(html: string): string | null {
  const raw = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
  const title = raw ? stripHtml(raw) : "";
  return title || null;
}

/** Composer + opera gate from the `podtip1` byline ("opera by {Composer}" /
 *  Russian "опера {Composer}"). Returns the composer only for opera bylines;
 *  every other byline (ballet/operetta/concert) and a missing/empty byline yield
 *  null and drop the page. This is the sole genre gate — see the header note on
 *  why "Music by …" is deliberately not a fallback. */
function parseComposer(html: string): string | null {
  const byline = stripHtml(html.match(/class="podtip1">([\s\S]*?)<\/[a-z]/i)?.[1] ?? "");
  const en = byline.match(/^\s*opera\s+by\s+(.+)$/i);
  if (en?.[1]) return composerName(en[1]);
  const ru = byline.match(/^\s*опера\s+(.+)$/i);
  if (ru?.[1]) return composerName(ru[1]);
  return null;
}

/** Venue room from the `itemprop="location"` string, dropping the "St Petersburg,"
 *  city prefix → "Mariinsky Theatre" / "Mariinsky II" / "Concert Hall". */
function parseVenue(html: string): string | null {
  const raw = stripHtml(html.match(/itemprop="location"[^>]*>([^<]+)/i)?.[1] ?? "");
  if (!raw) return null;
  const room = raw.replace(/^[^,]*,\s*/, "").trim();
  return room || raw;
}

/** "Premiere of this production: 8 March 2005" → ISO. Prefers the production
 *  premiere over the (often 19th-century) world premiere. */
function parseProductionPremiere(html: string): IsoDate | null {
  const text = stripHtml(html);
  const m =
    text.match(/Premiere of this production:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i) ??
    text.match(/Premiere at the Mariinsky[^:]*:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  return m?.[1] ? parseEnglishDate(m[1]) : null;
}

function parseImage(html: string): string | null {
  const src = html.match(/<img[^>]+src="(\/images\/cms\/data\/[^"]+)"/i)?.[1];
  return src ? `${BASE}${src}` : null;
}

function parseSynopsis(html: string): string | null {
  const block = html.match(/class="story inf_block[^"]*">([\s\S]*?)<\/div>\s*<\/div>/i)?.[1];
  const text = block ? stripHtml(block) : "";
  return text ? text.slice(0, 2000) : null;
}

/** Creative team from the `avtori` (Credits) block's "Label: Name" lines. Labels
 *  map via CREATIVE_FUNCTIONS (English) / RU_CREATIVE_FUNCTIONS (Russian); the
 *  "Music by"/"Libretto by" preamble and unmapped labels are dropped. */
function parseCreative(html: string): RawCredit[] {
  const block = html.match(/avtori inf_block[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i)?.[1];
  if (!block) return [];

  const out: RawCredit[] = [];
  const seen = new Set<string>();
  for (const { label, name } of labelledLines(block)) {
    const fn =
      CREATIVE_FUNCTIONS[label.toLowerCase()] ?? RU_CREATIVE_FUNCTIONS[label.toLowerCase()];
    if (!fn || !isPersonName(name)) continue;
    const key = `${fn}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ function: fn, name });
  }
  return out;
}

/** Cast from the `sostav` (Performers) block: the leading Conductor line plus the
 *  "Role: Singer" lines. */
function parseCast(html: string): RawCredit[] {
  const block = html.match(/sostav inf_block[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i)?.[1];
  if (!block) return [];

  const out: RawCredit[] = [];
  const seen = new Set<string>();
  const add = (entry: RawCredit) => {
    const key = `${entry.role ?? entry.function ?? ""}|${entry.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  for (const { label, name } of labelledLines(block)) {
    if (!isPersonName(name)) continue;
    const lower = label.toLowerCase();
    if (lower === "conductor" || lower === "дирижёр" || lower === "дирижер") {
      add({ function: "conductor", name });
      continue;
    }
    if (isRoleLabel(label)) add({ role: label, name });
  }
  return out;
}

interface LabelledLine {
  label: string;
  name: string;
}

/** Split a credit/cast block into "Label: Name" lines. The markup is a run of
 *  `Label: <a>Name</a>` (or plain "Label: Name") segments separated by `<br>` and
 *  `</p>`; each yields one label + the first linked/trailing name. */
function labelledLines(block: string): LabelledLine[] {
  const out: LabelledLine[] = [];
  for (const raw of block.split(/<br\s*\/?>|<\/p>|<\/div>/i)) {
    const text = stripHtml(decodeEntities(raw));
    const m = text.match(/^([^:]{1,40}):\s*(.+)$/);
    if (!m) continue;
    const label = m[1]?.trim() ?? "";
    // Names carry trailing parentheticals ("(after sketches by …)") and co-credits
    // separated by "/" or ","; keep the first person only.
    const name = cleanName((m[2] ?? "").split(/\s*[/,]\s*|\s*\(/)[0] ?? "");
    if (label && name) out.push({ label, name });
  }
  return out;
}

/** The composer from an "opera by …" byline. Drops the trailing descriptive
 *  clause some bylines append (e.g. "Richard Wagner, first part of the tetralogy
 *  Der Ring des Nibelungen" → "Richard Wagner"). */
function composerName(fragment: string): string | null {
  const name = cleanName(fragment.split(/\s*,\s*/)[0] ?? "");
  return name || null;
}

/** Strip entities/markup noise and Studio/footnote markers from a person name. */
function cleanName(fragment: string): string {
  return stripHtml(decodeEntities(fragment))
    .replace(/\([^)]*\)/g, " ")
    .replace(/[*†]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,;–-]+|[,;–-]+$/g, "")
    .trim();
}

/** A cast "role" label is a short character name, not a sentence or stray prose. */
function isRoleLabel(label: string): boolean {
  return label.length > 0 && label.length <= 40 && !/[.!?]/.test(label);
}

/** A person name: short, has a letter, no sentence punctuation or digits. */
function isPersonName(name: string): boolean {
  return (
    name.length > 1 &&
    name.length <= 60 &&
    /\p{L}/u.test(name) &&
    !/[.!?:]/.test(name) &&
    !/\d/.test(name)
  );
}

const MONTHS: Record<string, number> = {
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

/** "8 March 2005" → "2005-03-08". */
function parseEnglishDate(text: string): IsoDate | null {
  const m = text.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[2]?.toLowerCase() ?? ""];
  if (!month) return null;
  return `${m[3]}-${pad(month)}-${pad(Number(m[1]))}` as IsoDate;
}

/** "1900" / "930" → "19:00" / "09:30". */
function parseUrlTime(hhmm: string | undefined): string | null {
  if (!hhmm) return null;
  const padded = hhmm.padStart(4, "0");
  const h = Number(padded.slice(0, 2));
  const min = padded.slice(2);
  if (h > 23) return null;
  return `${pad(h)}:${min}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
