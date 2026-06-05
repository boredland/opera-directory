# AGENTS.md

Read [`README.md`](README.md) top to bottom first — it is the project guide
(data model, scraper contract, source registry, pipeline shape). This file holds
operational notes that don't belong in the README.

## Fetch proxy (`FETCH_PROXY_URL` + `FETCH_PROXY_TOKEN`)

Route a house's fetches through the proxy when it blocks the runner's datacenter
IP, serves a broken TLS chain, or gates content behind a Cloudflare challenge /
JS render — a direct fetch returns a challenge or empty page. In the scraper
contract, set `proxy: true` on the house; `fetchRendered()`
(`packages/scrapers/src/fetch.ts`) already prefers the proxy's stealth render
(`?render=1&wait=<ms>`) and falls back to a local headless Chromium when no proxy
is configured (dev) or the proxy render fails.

The proxy is one endpoint (`GET /`, or `POST` to forward the request body +
Content-Type upstream). The base tier is a Chrome-UA fetch with TLS verification
off (covers datacenter-IP blocks and broken certs); query params escalate from
there:

| param | effect |
|-------|--------|
| `url` | **Required.** Target URL (url-encoded). |
| `auto=1` | Auto-escalate `plain → FlareSolverr → stealth render`, returning the first tier that isn't blocked. `auto=0` opts out if the server defaults it on. |
| `solve=1` | Force the FlareSolverr (Cloudflare-challenge solver) path even when the CF heuristic doesn't fire. |
| `render=1` | Stealth headless-Chromium render (JS/SPA content). |
| `wait=<ms>` | With `render=1`, ms to let the SPA's XHR content settle. Default `6000`, max `30000`. |
| `format=md` | Convert HTML to Markdown via Readability main-content extraction (nav/ads dropped, links absolutized). Omit for raw HTML. |
| `block=0` | Ad/cookie/tracker blocking (uBO-style lists) is on by default for rendered pages; set `0` to disable it. |

Full spec at `$FETCH_PROXY_URL`docs (Scalar UI; raw at `/docs/json`).

It's a last resort — slower and rate-limited — so reach for it only after the
cheaper source tiers and a plain fetch have failed.

**Config.** Both values live in GitHub **twice** — as **Actions secrets** (read
in **CI**; `scrape.yml` injects `${{ secrets.* }}`) and as **Actions variables**
(read in **development**). Locally, hydrate from the variables rather than pasting
the bearer: `export FETCH_PROXY_URL=$(gh variable get FETCH_PROXY_URL)` and
`export FETCH_PROXY_TOKEN=$(gh variable get FETCH_PROXY_TOKEN)`. Never hardcode
the proxy URL or bearer in source.
