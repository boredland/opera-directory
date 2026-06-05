import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml } from "../fetch";
import type { RawPerformance, ScrapeWindow } from "../types";

/**
 * Shared spielplan walker for the flat-file calendar CMS behind Theater Regensburg
 * and Theater Aachen. Their public spielplan is filtered client-side (the listing
 * HTML carries no production links), but each month is available server-rendered
 * from an `?ajax=1&offset={month}` endpoint — offset 0 is the current month, each
 * step +1 month. Every performance is one element whose class carries the date
 * (`date-{DDMMYY}`), the genre (`sparte-{n}`), an inner `produktionen/{slug}.html`
 * link and a "HH:MM Uhr" / "HH.MM Uhr" time.
 *
 * The two houses share this calendar shape but diverge in detail-page markup
 * (Besetzung, composer line) and in which `sparte-{n}` is opera, so each adapter
 * passes its own `operaSparten` and parses its own detail pages. We walk a fixed
 * span of months rather than stopping at the first empty one: the summer break
 * shows up as one or more empty months mid-range.
 */

const MONTHS_AHEAD = 13;

interface MonthRow {
  slug: string;
  perf: RawPerformance;
}

export async function walkSpielplanCalendar(
  ctx: FetchContext,
  opts: { ajaxUrl: (offset: number) => string; operaSparten: Set<string> },
  window: ScrapeWindow,
): Promise<Map<string, RawPerformance[]>> {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map<string, RawPerformance[]>();
  for (let offset = 0; offset <= MONTHS_AHEAD; offset++) {
    let html: string;
    try {
      html = await fetchHtml(opts.ajaxUrl(offset), ctx);
    } catch {
      continue; // a month may 500/timeout; skip it, keep walking the season
    }
    for (const { slug, perf } of parseMonth(html, opts.operaSparten, window, today)) {
      const list = bySlug.get(slug) ?? [];
      list.push(perf);
      bySlug.set(slug, list);
    }
  }

  for (const [slug, perfs] of bySlug) {
    const seen = new Set<string>();
    bySlug.set(
      slug,
      perfs
        .filter((p) => {
          const k = `${p.date}|${p.time ?? ""}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "")),
    );
  }
  return bySlug;
}

/** One match per performance row; the genre lives in a `sparte-{n}` class on the
 *  same element, so filter before reading the inner slug/time. The row body runs
 *  from this row's class to the next row's, bounding the slug/time search. */
function parseMonth(
  html: string,
  operaSparten: Set<string>,
  window: ScrapeWindow,
  today: string,
): MonthRow[] {
  const out: MonthRow[] = [];
  const matches = [
    ...html.matchAll(/class="([^"]*\bperformance\b[^"]*\bdate-(\d{2})(\d{2})(\d{2})[^"]*)"/g),
  ];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m) continue;
    const cls = m[1] ?? "";
    const sparten = [...cls.matchAll(/sparte-(\d+)/g)].map((x) => x[1]);
    if (!sparten.some((s) => s && operaSparten.has(s))) continue;

    const start = (m.index ?? 0) + m[0].length;
    const end = matches[i + 1]?.index ?? Math.min(html.length, start + 2000);
    const seg = html.slice(start, end);
    const slug = seg.match(/produktionen\/([a-z0-9-]+)\.html/)?.[1];
    if (!slug) continue;

    const date = `20${m[4]}-${m[3]}-${m[2]}` as IsoDate;
    if (window.since && date < window.since) continue;
    const tm = seg.match(/(\d{1,2})[:.](\d{2})(?:&nbsp;|\s)*Uhr/);
    const time = tm ? `${tm[1]?.padStart(2, "0")}:${tm[2]}` : null;
    out.push({ slug, perf: { date, time, status: date < today ? "past" : "scheduled" } });
  }
  return out;
}
