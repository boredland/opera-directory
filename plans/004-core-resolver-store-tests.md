# Plan 004: Characterization tests lock the resolver + store invariants (idempotency, deterministic slugs)

> **Executor instructions**: Follow step by step; run every verification command
> and confirm the result before moving on. If a STOP condition occurs, stop and
> report. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5cdc985..HEAD -- packages/ingest/src`
> If `resolve.ts` or `store.ts` changed, compare the excerpts below against the
> live code before writing tests; tests must assert *current* behavior.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `5cdc985`, 2026-06-18
- **Issue**: https://github.com/boredland/opera-directory/issues/50

## Why this matters

The resolver (`ingestRawProduction`) and store (`CanonicalStore`) are the
make-or-break pass: free-text scraped names collapse onto stable canonical
entities, and the pipeline's core promise is that **re-running converges and
never duplicates** (README §5, "Idempotency is the whole game"). That guarantee
and the deterministic slug rules are **entirely untested** — there are zero test
files in the repo. Phase 1 will rewrite resolution to add Wikidata/MusicBrainz
tiers; without characterization tests, that rewrite is blind. This plan sets up
Bun's built-in test runner and locks the current behavior.

## Current state

- No test runner configured: no `.test.ts` files, no `test` script in any
  `package.json`. Bun ships a built-in runner (`bun test`, Jest-like
  `describe/test/expect` from `"bun:test"`).
- `packages/ingest/src/resolve.ts` — pure, testable functions:
  - `slugify(input: string): Slug` (`resolve.ts:39-46`) — lowercase, NFKD,
    strip diacritics, non-alphanumeric → `-`, trim leading/trailing `-`.
  - `workKey(title, composerName): string` (`resolve.ts:49-51`) —
    `` `${slugify(composer ?? "")}::${slugify(title)}` ``.
  - `ingestRawProduction(store, raw, houseSlug): void` (`resolve.ts:56-122`) —
    resolves work/persons/roles and upserts a production + its performances.
    Work slug = `composer.slug/title-slug` (or just `title-slug` if no composer);
    production id = `house/work-title-slug/season-slug` when `premiere_season` is
    set, else `house/source-id-slug` (`resolve.ts:84-86`); performance id =
    `${productionId}/${date}/${time ?? ""}` (`resolve.ts:106`). Cast credits with
    no `role` are dropped (`resolve.ts:131`); creative credits with no `function`
    are dropped (`resolve.ts:77`).
- `packages/ingest/src/store.ts` — `CanonicalStore` (constructible with
  `new CanonicalStore()`; public Maps `works/persons/roles/productions/
  performances`, `upsert*` methods, `counts()`). Key behaviors:
  - `mergeFill(base, next)` (`store.ts:160-167`) — fills fields of `base` that are
    `null`/`undefined`/`""` from `next`; **keeps already-set values** (first write wins).
  - `upsertPerson` unions `professions` (`store.ts:90-96`, `unionList` `:169-172`).
  - `upsertProduction` replaces by id (`store.ts:105-107`); `upsertWork`/`Person`/
    `Role`/`Performance` merge-fill.
- `RawProduction`/`RawCredit`/`RawPerformance` types: `@opera-directory/scrapers`
  (`packages/scrapers/src/types.ts`). Import the types from the package root.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Run tests | `bun test` | all pass |
| Run ingest tests only | `bun test packages/ingest` | all pass |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |

## Scope

**In scope** (create/modify):
- `packages/ingest/src/resolve.test.ts` (create)
- `packages/ingest/src/store.test.ts` (create)
- `package.json` (root) — add `"test": "bun test"`
- Optionally `packages/ingest/package.json` — add `"test": "bun test"` (per-package)

**Out of scope** (do NOT touch):
- `resolve.ts`, `store.ts` source — this plan only *characterizes* current
  behavior. If a test reveals a bug, record it in NOTES; do **not** fix it here.
- Any `data/` file or adapter.

## Git workflow

Commit directly to `main`, conventional-commit style. Suggested:
`test(ingest): characterization tests for resolver + store invariants`.

## Steps

### Step 1: Add the test script(s)

Add `"test": "bun test"` to root `package.json` `scripts`. (Bun discovers
`*.test.ts` recursively.)

**Verify**: `bun test` → runs (0 tests is fine at this point), exit 0.

### Step 2: `resolve.test.ts` — slug + key + resolution behavior

Cover, with `expect`:
- `slugify`: `"Wolfgang Amadeus Mozart"` → `"wolfgang-amadeus-mozart"`;
  accents folded (`"Léo Delibes"` → `"leo-delibes"`); leading/trailing
  punctuation trimmed; empty/punct-only input → `""`.
- `workKey`: `workKey("Le nozze di Figaro", "W. A. Mozart")` equals
  `` `${slugify("W. A. Mozart")}::${slugify("Le nozze di Figaro")}` ``; a
  null composer yields a leading `"::"`.
- `ingestRawProduction` on a fresh `new CanonicalStore()` with a fixture
  RawProduction (composer + 2 cast with roles + 1 creative with `function` +
  2 performances + `premiere_season: "2025/26"`):
  - mints a work slug `composer-slug/title-slug`, a production id
    `house/title-slug/2025-26`, two performance ids `…/date/time`;
  - a cast credit with `role: null` is **dropped**; a creative credit with
    `function: null` is **dropped** (assert the counts reflect the drops).

### Step 3: `store.test.ts` — idempotency + merge semantics

- **Idempotency (the load-bearing invariant)**: ingest the same fixture twice
  into one store; assert `store.counts()` is identical after the 2nd run and the
  same slugs/ids exist (no duplicates).
- **mergeFill first-write-wins**: `upsertWork({slug, title:"A", composer_slug:"c", wikidata:null})`
  then `upsertWork({slug, title:"B", composer_slug:"c", wikidata:"Q1"})` → title
  stays `"A"` (already set), `wikidata` becomes `"Q1"` (was null). 
- **professions union**: `upsertPerson` same slug with `["composer"]` then
  `["conductor"]` → `professions` is the sorted union `["composer","conductor"]`.
- **performance merge**: upsert a performance, then upsert same id with a new
  non-null field that was null before → filled; an already-set field → unchanged.

### Step 4: Run and confirm

**Verify**: `bun test` → all pass; `bun run typecheck` → 0; `bun run lint` → 0.

## Test plan

This plan *is* the test plan. New files: `resolve.test.ts` (slug/key/resolution),
`store.test.ts` (idempotency/merge/union). Use `"bun:test"` (`import { describe, test, expect } from "bun:test"`).
Construct stores with `new CanonicalStore()` — no disk IO needed. Build RawProduction
fixtures inline as typed literals.

## Done criteria

ALL must hold:

- [ ] `bun test` exits 0 with ≥ 10 assertions across the two files
- [ ] An idempotency test exists asserting `counts()` is unchanged on a 2nd ingest
- [ ] `bun run typecheck` and `bun run lint` exit 0
- [ ] Only `packages/ingest/src/*.test.ts` and `package.json` files changed
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- A characterization test cannot reproduce the documented behavior because the
  source has drifted from the excerpts (re-read and report the difference).
- A test exposes what looks like a real bug (e.g. non-idempotent output) — record
  it in NOTES and leave the test asserting *actual* behavior with a `// FIXME`
  comment; do not fix source in this plan.
- `new CanonicalStore()` is not constructible (constructor became private).

## Maintenance notes

- These tests are the safety net for Phase 1's Wikidata/MusicBrainz resolution
  rewrite — when QID-keyed resolution lands, update the slug-expectation tests
  deliberately (they should *fail* first, proving the change took effect).
- Plan 002's `validate.test.ts` should follow the structure established here.
- A reviewer should check the idempotency test actually re-ingests (not just
  asserts a single run) and that assertions check values, not just `toBeDefined()`.
