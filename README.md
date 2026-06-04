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
the stable-identity rules in the schema are what make that hold.

Entry point: [`packages/ingest/src/index.ts`](packages/ingest/src/index.ts)
(`runScrape()`), runnable with `bun run scrape [house-slug …]`. Scheduled daily
via [`.github/workflows/scrape.yml`](.github/workflows/scrape.yml).

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
│   │   ├── src/fetch.ts            ← proxy fetch + schema.org JSON-LD extractor
│   │   ├── src/types.ts            ← Raw* rows, HouseScraper, SourceStrategy
│   │   ├── src/index.ts            ← HOUSE_SCRAPERS registry
│   │   └── src/houses/oper-frankfurt.ts  ← WORKED EXAMPLE adapter
│   └── ingest/
│       ├── src/resolve.ts          ← entity resolution (tiers + stubs)
│       └── src/index.ts            ← runScrape() pipeline entry
└── .github/workflows/scrape.yml    ← daily scheduled scrape
```

---

## 8. Roadmap

- [ ] **Phase 0 — pipeline spine.** Finish `oper-frankfurt` (future + archive),
      implement resolver tiers 3+4, add SQLite/Drizzle persistence, make
      `bun run scrape oper-frankfurt` produce a real DB end to end.
- [ ] **Phase 1 — accuracy.** Wikidata tier-1 resolution + MusicBrainz tier-2;
      review queue for provisional entities.
- [ ] **Phase 2 — breadth.** Enable the seeded houses (Wien, München, ROH, Met,
      La Scala); add archive importers for the gold-standard house databases.
- [ ] **Phase 3 — the site.** `opera.directory` front end: work / production /
      house / person / role pages, search, season views.
- [ ] **Phase 4 — scale-out.** A `jsonld-event` adapter that works generically
      across the long tail of houses, driven entirely by `houses.json`.

## 9. Getting started

```bash
mise use -g bun@latest        # one-time, if bun isn't installed
bun install                   # from repo root
bun run typecheck
bun run scrape oper-frankfurt # runs the (currently empty) adapter end to end
```

Each open question for the implementer is marked with a `TODO(implementer)`
comment in the relevant file.
