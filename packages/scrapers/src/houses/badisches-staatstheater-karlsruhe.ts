import { type FetchContext, fetchHtml, stripHtml } from "../fetch";
import type { HouseScrapeResult, ScrapeWindow } from "../types";

/**
 * Badisches Staatstheater Karlsruhe (`spielplan-html`).
 *
 * The site 403s every non-residential client; only the FETCH_PROXY (FlareSolverr
 * + residential IP, CI-only) can reach it. This pass is RECON: it probes the
 * listing + a detail page through the proxy and logs the structure so the real
 * parser can be written from CI logs. Detail pages are /programm/info/{id}/.
 * Emits nothing yet.
 */

const BASE = "https://staatstheater.karlsruhe.de";

export async function scrapeBadischesStaatstheaterKarlsruhe(
  ctx: FetchContext,
  _window: ScrapeWindow,
): Promise<HouseScrapeResult> {
  console.warn(`karlsruhe: proxy=${ctx.proxy ? "on" : "OFF"}`);
  for (const path of ["/programm/spielplan/", "/spielplan/", "/programm/", "/"]) {
    try {
      const html = await fetchHtml(`${BASE}${path}`, ctx);
      const infoLinks = [...new Set(html.match(/\/programm\/info\/\d+\//g) ?? [])];
      console.warn(`karlsruhe: ${path} → ${html.length}b, ${infoLinks.length} info-links`);
      if (infoLinks.length > 0) {
        console.warn(`karlsruhe: sample links ${infoLinks.slice(0, 5).join(" ")}`);
        await probeDetail(ctx, infoLinks[0] ?? "");
        break;
      }
    } catch (err) {
      console.warn(`karlsruhe: ${path} failed: ${err}`);
    }
  }
  return { house_slug: "badisches-staatstheater-karlsruhe", productions: [] };
}

async function probeDetail(ctx: FetchContext, link: string): Promise<void> {
  try {
    const html = await fetchHtml(`${BASE}${link}`, ctx);
    const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
    const meta = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/)?.[1] ?? "";
    console.warn(`karlsruhe detail ${link}: ${html.length}b`);
    console.warn(`karlsruhe h1: ${h1.slice(0, 80)}`);
    console.warn(`karlsruhe meta: ${meta.slice(0, 220)}`);
    console.warn(
      `karlsruhe markers: jsonld=${(html.match(/ld\+json/g) ?? []).length} ` +
        `Besetzung=${(html.match(/Besetzung/g) ?? []).length} ` +
        `'von'=${(html.match(/\bvon /g) ?? []).length} ` +
        `dates=${(html.match(/\d{1,2}\.\d{1,2}\.\d{4}/g) ?? []).length}`,
    );
  } catch (err) {
    console.warn(`karlsruhe detail ${link} failed: ${err}`);
  }
}
