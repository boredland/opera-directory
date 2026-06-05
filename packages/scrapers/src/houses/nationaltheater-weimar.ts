import type { IsoDate } from "@opera-directory/schema";
import { type FetchContext, fetchHtml, fetchJson, stripHtml } from "../fetch";
import { scrapeWikidataProductions } from "../strategies/wikidata";
import type { HouseScrapeResult, RawPerformance, RawProduction, ScrapeWindow } from "../types";
import { composerFromText } from "./_german-credits";

/**
 * Deutsches Nationaltheater Weimar (`json-api` strategy).
 *
 * Custom PHP CMS; the spielplan is JS-rendered but backed by a monthly AJAX endpoint
 * `/ext/ajax/spielplan_ajax.php?month=YYYY-MM` → `{ "YYYY-MM-DD": [event, …] }`. Each
 * event has `stu_pid` (production id), `stu_titel`, `ter_datum` ("YYYY-MM-DD HH:MM:SS")
 * and `filter_tags` (genre — cat-3 = Oper). Walk the season's months, group by stu_pid;
 * the composer comes from each detail page ("… von Composer"). Future-only → Wikidata.
 */

const BASE = "https://www.dnt-weimar.de";
/** DNT Weimar on Wikidata — see data/houses.json. */
const WIKIDATA_QID = "Q600939";

interface WeimarEvent {
  stu_pid?: number;
  stu_titel?: string;
  ter_datum?: string;
  filter_tags?: string;
}

export async function scrapeNationaltheaterWeimar(
  ctx: FetchContext,
  window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const bySid = new Map<number, { title: string; perfs: RawPerformance[] }>();
  for (const month of nextMonths(13)) {
    let data: Record<string, WeimarEvent[]>;
    try {
      data = await fetchJson<Record<string, WeimarEvent[]>>(
        `${BASE}/ext/ajax/spielplan_ajax.php?month=${month}`,
        ctx,
      );
    } catch {
      continue;
    }
    for (const events of Object.values(data)) {
      for (const e of events) {
        if (e.stu_pid == null || !/\bcat-3\b/.test(` ${e.filter_tags ?? ""} `)) continue;
        const m = e.ter_datum?.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
        if (!m) continue;
        const date = m[1] as IsoDate;
        if (window.since && date < window.since) continue;
        const entry = bySid.get(e.stu_pid) ?? { title: stripHtml(e.stu_titel ?? ""), perfs: [] };
        if (!entry.perfs.some((p) => p.date === date && p.time === m[2])) {
          entry.perfs.push({
            date,
            time: m[2] ?? null,
            status: date < today ? "past" : "scheduled",
          });
        }
        bySid.set(e.stu_pid, entry);
      }
    }
  }

  const productions: RawProduction[] = [];
  for (const [sid, { title, perfs }] of bySid) {
    if (!title || perfs.length === 0) continue;
    const detailUrl = `${BASE}/de/programm/stueck-detail.php?SID=${sid}`;
    let composer: string | null = null;
    try {
      const html = await fetchHtml(detailUrl, ctx);
      composer = composerFromText(stripHtml(html.match(/von\s+[A-ZÄÖÜ][\s\S]{0,80}/)?.[0] ?? ""));
    } catch {
      /* composer stays null; cross-house merge fills common works */
    }
    perfs.sort(
      (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
    );
    productions.push({
      source_production_id: String(sid),
      work_title: title,
      composer_name: composer,
      detail_url: detailUrl,
      performances: perfs,
    });
  }

  if (window.mode === "backfill") {
    try {
      productions.push(...(await scrapeWikidataProductions(WIKIDATA_QID, ctx, window)));
    } catch (err) {
      console.warn("nationaltheater-weimar: wikidata backfill failed:", err);
    }
  }
  return { house_slug: "nationaltheater-weimar", productions };
}

/** Current month + the next N-1 months as "YYYY-MM". */
function nextMonths(n: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
