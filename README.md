# opera.directory

A public, browsable database of opera **productions** — past and future —
across the world's opera houses. Modeled on [operabook.org](https://www.operabook.org/)
and [Operabase](https://www.operabase.com/): click a work and see every staging
of it; click a house and see its seasons; click a singer and follow them from
production to production.

> **Status: scaffolding + approach doc.** This repo is an initialized skeleton.
> The data model, scraper contract, source registry, and pipeline shape are in
> place; the per-house parsers, entity resolution, persistence, and the web app
> are not yet built. This README is written for the next agent to pick up. Read
> it top to bottom before writing code.

---

## 1. What we're building, precisely

operabook.org organizes the opera world around three nouns — **artists**,
**roles**, **performances** — and sits behind a login. We want the same graph,
**public and open**, with the *production* promoted to a first-class entity.

The single most important modeling decision, and the reason this is **not** a
fork of the museumsufer event-scraper monorepo:

> An opera **production** is a durable, richly-related entity — not a dated event.
> One production of _Carmen_ at a house is a single creative act (one director,
> one conductor, one design) that recurs across dozens of dated performances and
> sometimes multiple seasons (revivals).

The flat "one row per dated event" shape that powers the Frankfurt culture apps
cannot express "every production of this work" or "this director's body of work."
So the model here is **relational**, with five canonical entities:

```
Work ──< Production >── House
 │           │
 │           ├──< Performance (dated showings)
 │           ├── CreativeCredit  → Person   (conductor, director, designers…)
 │           └── CastCredit      → Person + Role
 └──< Role
```

The canonical types live in [`packages/schema/src/types.ts`](packages/schema/src/types.ts)
— start there; it documents every field and the stable-identity rules.

---

## 2. Where the data comes from

This is the hard part and where most of the effort goes. Treat sources in tiers,
cheapest-and-most-trustworthy first. **The "big dataset" of *past* productions
comes mostly from archives and aggregators; the *future* comes from each house's
live spielplan.** You need both legs.

### Tier 0 — Open aggregators (backfill the long tail of history)

- **Wikidata (CC0, SPARQL endpoint)** — the canonical registry for works,
  composers, and notable people, and a real source of past productions/premieres
  via WikiProject Performing Arts (production modeled as the primary object,
  linked to venue `P276` and company `P272`). Use it for (a) entity resolution
  (see §4) and (b) historical backfill where house archives are thin.
  Endpoint: `https://query.wikidata.org/sparql`.
- **MusicBrainz** — stable MBIDs for works and artists; fills gaps Wikidata
  misses and gives us a second cross-link.
- **House-run public archives** — several houses publish *excellent* historical
  databases that are the gold standard for backfill:
  - Metropolitan Opera — _MetOpera Database_ (`archives.metopera.org`), back to 1883.
  - Wiener Staatsoper — _Aufführungsdatenbank_, back to 1869.
  - Royal Opera House — _ROH Collections_.
  Prioritize these per-house archives over generic scraping.

### Tier 1 — Per-house live sources (the future leg)

Each house gets an **adapter** keyed by slug (see §3). Pick the cheapest source
shape that still yields **cast + creative team**, which is what makes the graph
valuable. Common shapes (encoded as `SourceStrategy` in the scraper types):

| Strategy          | When                                                   | Notes |
|-------------------|--------------------------------------------------------|-------|
| `jsonld-event`    | Modern CMS / ticketing emits schema.org `Event` JSON-LD | Cheapest. `extractEventJsonLd()` in `fetch.ts` already pulls these. performer/startDate/location often pre-structured. |
| `spielplan-html`  | Bespoke HTML spielplan + archive (e.g. Oper Frankfurt) | Most work. See the worked example. |
| `spektrix-api`    | House uses Spektrix ticketing                          | JSON API behind the what's-on widget. |
| `tessitura-api`   | House uses Tessitura (ROH, many US houses)             | TNEW / REST endpoints; production+performance JSON. |
| `wikidata-sparql` | Backfill-only houses with no scrapable archive         | Query Wikidata for that house's productions. |
| `manual`          | Hand-curated seed until an adapter exists              | Keeps the house visible without a live scrape. |

### A note on Operabase

Operabase is the dominant commercial opera database (800k+ performances). It is
**not** an open source — it sits behind login/terms and there is no public API.
Do **not** scrape it as a primary source: it's a licensing and ToS risk, and our
value proposition is being *open*. Use it only as a manual cross-check during QA.

### Legal / etiquette

- Honor `robots.txt` and rate-limit (the toolkit ships a `p-queue` dependency for this).
- Identify the crawler honestly via User-Agent (`DEFAULT_UA` points at an about page).
- Facts (who sang what, when) aren't copyrightable; synopses and production
  photos are — store URLs/short excerpts, not wholesale copies, and attribute.
- Prefer the open aggregators and house-run archives, which exist to be queried.

---

## 3. How a house adapter works

Adapters live in [`packages/scrapers/src/houses/`](packages/scrapers/src/houses/),
one file per house, registered in [`index.ts`](packages/scrapers/src/index.ts).
Each is a `HouseScraper`: given a `FetchContext`, return a `HouseScrapeResult`
of **`RawProduction`** rows (loosely typed — names as free text, no IDs).

Two rules every adapter follows:

1. **Cover past *and* future.** Scrape the live spielplan _and_ walk the season
   archive. Skipping the archive throws away the dataset's main value.
2. **Group by production, not by date.** The same show on 12 nights is **one**
   `RawProduction` with 12 `RawPerformance` rows. Group on
   `(work_title + premiere_season)`. Pull creative team + cast once from the
   production's detail page.

Adapters stay **dumb and faithful**: emit exactly what the page says and
normalize only dates/times and credit-function labels. They must **not** guess
canonical identity — that's the resolver's job (§4), kept separate so a bad
fuzzy match can't silently corrupt a scraper.

The reference adapter is
[`houses/oper-frankfurt.ts`](packages/scrapers/src/houses/oper-frankfurt.ts).
A battle-tested Oper Frankfurt event parser already exists in the museumsufer
monorepo (`packages/scrapers/src/venues/oper-frankfurt.ts`) — port its HTML
parsing, then **regroup** flat events into productions.

### How we discover *past* productions

The future advertises itself — the live spielplan is a bounded, self-listing
set. The past does not: nothing hands you "every production since 1990," so you
must **enumerate** it, and there is no single way. Discovery is per-source, in
three mechanisms (which map onto the `SourceStrategy` and the per-house `notes`
in `houses.json`):

1. **Walk the house's own archive index** (`spielplan-html`, `*-api`). Find the
   archive's **season index**, then iterate seasons backward; each season page
   yields the production detail URLs you fetch and regroup. The index URL +
   its season pagination is the thing each adapter has to know — that's exactly
   what the `notes` field carries (Oper Frankfurt: `/de/spielplan/archiv/`).
2. **Import a gold-standard house database** (Met → 1883, Wien → 1869, ROH
   Collections). These run real archives; discovery is their own browse/search
   index, usually paginated by season or work. They're **separate archive
   importers** (Phase 2), not the live adapter, and give stable upstream IDs.
3. **Let an aggregator enumerate for you** (`wikidata-sparql`). For houses with
   no scrapable archive, don't discover one-by-one — ask Wikidata to list every
   work premiered at the house (`P4647`) or produced by it (`P272`), with composer
   (`P86`) and first-performance date (`P1191`). The QID lives in `houses.json`
   (`oper-frankfurt → Q568931`). **Implemented** in
   [`scrapers/src/strategies/wikidata.ts`](packages/scrapers/src/strategies/wikidata.ts)
   as a shared capability — `oper-frankfurt` calls it in `backfill` mode (it has
   no live archive), and the work QID rides along as `source_production_id` so the
   resolver gets an authoritative match for free. Coverage is thin and uneven
   (Frankfurt: 11 premieres; La Scala: 450+), so treat it as historical seed +
   resolution anchors, not a complete dataset.

   > Note: every `wikidata` QID in the original `houses.json` scaffold was wrong
   > (random entities — a galaxy, a Spanish village). They've been corrected and
   > verified; re-check any QID you add against `wbsearchentities` before trusting it.

### Two jobs, one contract: the scrape window

"Old" is really two different jobs, and conflating them re-walks the whole
archive every night. The adapter signature takes a **`ScrapeWindow`** so one
adapter serves both (see [`scrapers/src/types.ts`](packages/scrapers/src/types.ts)):

| Mode          | What it does                                                        | Runs            |
|---------------|---------------------------------------------------------------------|-----------------|
| `incremental` | Full announced future + shallow recent-past refresh. **No deep archive walk.** | daily (default) |
| `backfill`    | Walk the season archive back to `window.since` (unbounded when `null`). | once / rarely   |

The recent-past refresh exists because cast substitutions, cancellations, and
corrections land *after* a night is played; the daily run re-fetches a rolling
`DEFAULT_RECENT_PAST_DAYS` (45) window to catch them. The future leg ignores the
window — always emit the complete announced future.

Driven from the CLI:

```bash
bun run scrape oper-frankfurt                      # incremental: future + last 45 days
bun run scrape oper-frankfurt --backfill           # walk the full archive, oldest first
bun run scrape oper-frankfurt --backfill --since=1990-01-01   # archive back to 1990
```

The scheduled GitHub Action runs `incremental`; deep `backfill` is a manual /
one-off step per house when its adapter (or archive importer) first lands.

---

## 4. Entity resolution (the make-or-break pass)

Scrapers emit `"Wolfgang Amadeus Mozart"` and `"Le nozze di Figaro"`. To get the
operabook.org experience — one click from a work to every production of it — those
strings must collapse onto stable canonical `Work` / `Person` / `Role` entities.

Resolution is its own pass in [`packages/ingest/src/resolve.ts`](packages/ingest/src/resolve.ts),
in tiers, never auto-merging below a confidence threshold:

1. **Wikidata** (`wbsearchentities`, constrained by occupation `P106` / instance-of
   opera `Q1344`) — a QID match is authoritative.
2. **MusicBrainz** — fills work/artist gaps, adds MBIDs.
3. **Internal fuzzy** — normalized name (+ composer for works, + birth year for
   persons) against already-resolved entities.
4. **Mint provisional + flag for review** — provisional entities are still served;
   a later run folds them into a QID match. Ambiguous matches go to a review queue
   (mirror the museumsufer `audit-allowlist.json` pattern — false positives are
   data, not code).

Build tiers 3+4 first so the pipeline runs end-to-end offline, then layer in
Wikidata for accuracy.

---

## 5. The pipeline

```
data/houses.json
   └─▶ scrape   (per-house adapter → Raw* rows)        packages/scrapers
       └─▶ normalize (dates, credit labels)
           └─▶ resolve (link to canonical entities)    packages/ingest/resolve.ts
               └─▶ upsert (idempotent, stable-id keyed)
                   └─▶ persist (canonical store)
```

**Idempotency is the whole game.** Each run re-scrapes the future plus a rolling
window of recent past and upserts. Re-running must converge, never duplicate —
the stable-identity rules in the schema are what make that hold. **Implemented**:
resolution lives in [`ingest/src/resolve.ts`](packages/ingest/src/resolve.ts)
(`ingestRawProduction`), the store in [`ingest/src/store.ts`](packages/ingest/src/store.ts)
(`CanonicalStore`, load → upsert → save). Upsert is insert-or-merge and **never
deletes**, so a performance that rolls out of the live window survives from the
run that first saw it — that's how history accumulates. Output is sorted and
null-stripped for clean diffs; two runs over the same data are byte-identical.

Entry point: [`packages/ingest/src/index.ts`](packages/ingest/src/index.ts)
(`runScrape()`), runnable with `bun run scrape [house-slug …]`. Scheduled daily
via [`.github/workflows/scrape.yml`](.github/workflows/scrape.yml).

> **Known limitation — double bills.** A shared evening of two short works (e.g.
> Frankfurt's "Der Zar lässt sich fotografieren / Die Kluge") is currently
> resolved as a single combined `Work`, so its "Die Kluge" half does **not** link
> to the standalone `Die Kluge` work. The schema's `Production → one work_slug`
> can't express a two-work bill; fixing it means either splitting into linked
> productions or allowing multiple works per production. Left as-is for now.

---

## 6. Tech stack — and what changed vs. museumsufer

Keep what works in the sibling monorepo; change what the relational model demands.

**Kept:** TypeScript + **Bun** tooling, Biome, workspace packages, the
fetch-proxy passthrough + JSON-LD extractor (`fetch.ts`), GitHub Actions for the
scheduled scrape, Cloudflare for hosting.

**Changed — the deliberate departures:**

- **Persistence: committed JSON first, a derived SQLite read-copy only when
  scale demands it.** Keep museumsufer's best property — the data layer is
  *git-diff-reviewable*, so every scrape is a reviewable diff and a scraper
  regression shows up in a PR. Store the canonical graph as normalized JSON
  under `data/` (e.g. `works.json`, `productions.json`, `persons.json`,
  `roles.json`), committed and deployed on push. This is the **source of truth**
  and is plenty for the canonical entities (tens of thousands of rows).

  The one table that doesn't fit JSON is **`performances`** at archive scale:
  deep house archives (Met → 1883, Wien → 1869) plus a global house set push
  this into the hundreds of thousands of dated rows — you don't want a Worker
  loading an 800k-element array per request. So when the front end's query
  patterns and the performance count demand it (Phase 2-3, not day one),
  **derive** a read-only **SQLite/libSQL** copy (Cloudflare D1, or Turso) from the
  committed JSON in CI — generated, never hand-edited — and serve queries from
  it. Use [Drizzle](https://orm.drizzle.team) for that schema if/when you do.

  Net: JSON-only for the early phases; add the derived DB as a serving index
  later, keeping JSON as the diffable source. Don't reach for SQLite on day one.
- **A dedicated resolution layer.** No equivalent in museumsufer (events need no
  cross-linking). It's the core of the data quality here.
- **A web app is still TBD.** Hono + JSX SSR on Cloudflare Workers (the
  museumsufer stack) is a fine default for the `opera.directory` front end, but
  it isn't scaffolded here yet — the data layer comes first.

> Per the project's standing guidance: pre-prod posture — destructive schema
> changes are fine, no backwards-compat shims yet. Use `bun`, not npm/npx.

---

## 7. Repo layout

```
opera-directory/
├── README.md                       ← you are here (the approach)
├── package.json                    ← Bun workspace root
├── data/
│   └── houses.json                 ← curated house registry + per-house source notes
├── packages/
│   ├── schema/src/types.ts         ← canonical Work/Production/Performance/Person/Role/House
│   ├── scrapers/
│   │   ├── src/fetch.ts            ← proxy fetch, JSON-LD extractor, HTML/JSON helpers
│   │   ├── src/types.ts            ← Raw* rows, HouseScraper, ScrapeWindow, SourceStrategy
│   │   ├── src/index.ts            ← HOUSE_SCRAPERS registry
│   │   ├── src/strategies/wikidata.ts    ← shared wikidata-sparql backfill
│   │   ├── src/houses/_german-credits.ts ← shared German credit-label map
│   │   ├── src/houses/oper-frankfurt.ts  ← WORKED EXAMPLE adapter (future + wikidata backfill)
│   │   ├── src/houses/staatsoper-berlin.ts ← Staatsoper Unter den Linden (werke index + archive)
│   │   └── src/houses/metropolitan-opera.ts ← archive importer (MetOpera DB → 1883)
│   └── ingest/
│       ├── src/resolve.ts          ← entity resolution (tiers 3+4) + raw→canonical
│       ├── src/store.ts            ← CanonicalStore: load → upsert → save committed JSON
│       └── src/index.ts            ← runScrape() pipeline entry
└── .github/workflows/scrape.yml    ← daily scheduled scrape
```

---

## 8. Roadmap

- [x] **Phase 0 — pipeline spine. DONE.** `oper-frankfurt` future leg + Wikidata
      backfill produce real `RawProduction`s; resolver tiers 3+4 + a committed-JSON
      `CanonicalStore` turn them into the relational graph (`works/persons/roles/
      productions/performances.json`). `bun run scrape oper-frankfurt [--backfill]`
      runs end to end, idempotent and referentially intact. (SQLite/Drizzle read-copy
      is deferred to Phase 2-3, per §6 — JSON is the source of truth.)
- [ ] **Phase 1 — accuracy.** Wikidata tier-1 resolution + MusicBrainz tier-2;
      review queue for provisional entities.
- [~] **Phase 2 — breadth (in progress). Goal: the biggest German houses.**
      **Six German houses live**, each future + Wikidata backfill:
      **Oper Frankfurt** (`spielplan-html`), **Staatsoper Unter den Linden Berlin**
      (`spielplan-html`, werke index + archive), **Semperoper Dresden**
      (`spielplan-html`), **Oper Köln** (`json-api`), **Deutsche Oper Berlin**
      (`json-api`), **Staatsoper Stuttgart** (`render`). Plus the **MetOpera Database**
      archive importer (→1883). They merge into one graph — *Die Zauberflöte* resolves
      to a single work staged at five houses. Shared German credit-label map in
      `_german-credits.ts`.

      Three source shapes, cheapest first: plain fetch HTML (`spielplan-html`);
      a discovered JSON API (`json-api` — find it with `scripts/discover-api.mjs`,
      then fetch it, no runtime browser); and `render` for the SPAs with no API and
      no inline state, which run their JS via the headless `renderHtml` in fetch.ts
      (needs Chrome at scrape time — CI installs it; set `CHROME_PATH` locally).

      Still open: **Komische Oper Berlin** (JS-modal calendar, no clean detail URL)
      and **Hamburg** (`die-hamburgische-staatsoper.de`, didn't populate on render —
      needs interaction) — both `render` candidates needing more work.
      **Bayerische Staatsoper München** (the #1 house) is **offline for maintenance**
      — retry later. Also open: Wien (→1869) / ROH importers; full-season pagination
      for the window-only adapters (Köln, Dresden, DOB, Stuttgart).
- [ ] **Phase 3 — the site.** `opera.directory` front end: work / production /
      house / person / role pages, search, season views.
- [ ] **Phase 4 — scale-out.** A `jsonld-event` adapter that works generically
      across the long tail of houses, driven entirely by `houses.json`.

## 9. Getting started

```bash
mise use -g bun@latest        # one-time, if bun isn't installed
bun install                   # from repo root
bun run typecheck
bun run scrape oper-frankfurt # runs the implemented adapter (future leg) end to end
```

Each open question for the implementer is marked with a `TODO(implementer)`
comment in the relevant file.
