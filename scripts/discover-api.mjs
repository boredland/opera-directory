/**
 * House API discovery tool (dev only, not part of the scrape runtime).
 *
 * Many opera houses are JS SPAs that fetch their spielplan from a JSON endpoint
 * not visible in the static HTML. This loads a page in a headless browser and
 * logs the XHR/fetch requests it makes, so you can find that endpoint and then
 * write a normal fetch-based `json-api` adapter against it (see oper-koeln.ts,
 * deutsche-oper-berlin.ts — both found this way). Keeps the toolkit fetch-based:
 * the browser is used to DISCOVER the API, never to scrape.
 *
 *   bun scripts/discover-api.mjs <url> [url …]
 *
 * Needs a Chrome/Chromium; set CHROME_PATH or it tries /usr/bin/google-chrome-stable.
 */
import { chromium } from "playwright-core";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: bun scripts/discover-api.mjs <url> [url …]");
  process.exit(1);
}

const NOISE =
  /gtm|google|consent|cookie|matomo|facebook|sentry|track|beacon|usercentrics|onetrust|eye-able/i;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome-stable",
  headless: true,
});
for (const url of urls) {
  const ctx = await browser.newContext({
    userAgent: "opera.directory crawler (+https://opera.directory/about/crawler)",
  });
  const page = await ctx.newPage();
  const hits = new Set();
  page.on("response", (r) => {
    const u = r.url();
    const rt = r.request().resourceType();
    if ((rt === "xhr" || rt === "fetch") && !NOISE.test(u)) {
      hits.add(`${rt} ${(r.headers()["content-type"] || "").split(";")[0]} ${u}`);
    }
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(6000);
  } catch (e) {
    console.log(`${url}: ${e.message.split("\n")[0]}`);
  }
  console.log(`\n=== ${url} ===`);
  console.log(
    [...hits].sort().join("\n") || "(no xhr/fetch — server-rendered or needs runtime render)",
  );
  await ctx.close();
}
await browser.close();
