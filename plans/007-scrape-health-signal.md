# Plan 007: Per-house scrape health signal makes silently-failing adapters visible

> **Executor instructions**: Follow step by step; run every verification command
> and confirm the result before moving on. If a STOP condition occurs, stop and
> report. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5cdc985..HEAD -- packages/ingest/src packages/scrapers/src .github/workflows`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (complements plan 003's CI gate)
- **Category**: correctness
- **Planned at**: commit `5cdc985`, 2026-06-18
- **Issue**: https://github.com/boredland/opera-directory/issues/53

## Why this matters

Adapters are written to be resilient: they wrap fetches in
`try { … } catch (err) { console.warn(…) }` and return whatever they managed to
collect (e.g. `staatsoper-hamburg.ts:41-43`, `:49-51`, and the same shape across
the fleet). Combined with a store that **never deletes**, a house that starts
403ing or whose markup changed doesn't lose data — it silently **goes stale**:
it returns 0 (or far fewer) productions, contributes nothing, and no one notices
because the committed data still shows last month's shows. There is no per-house
success signal anywhere. This plan adds lightweight telemetry: each scrape
records what each house produced, and the run surfaces houses that returned 0 or
errored, so silent staleness becomes visible.

## Current state

- `runScrapeRaw(slug, window)` (`packages/ingest/src/index.ts:105-120`) scrapes one
  house, writes `raw/<slug>.json`, and logs a count line. `runScrape` (`:138-164`)
  does the same in-process loop and `console.error`s on a thrown adapter, but
  there is **no machine-readable per-house outcome** — just stdout lines.
- The raw artifact `raw/<slug>.json` is `{ house_slug, productions: [...] }`
  (`HouseScrapeResult`); a `productions.length` of 0 is a strong "this house
  failed or has nothing" signal but is never aggregated.
- CI (`.github/workflows/scrape.yml`): the `scrape` matrix job runs `scrape-raw`
  per house (`:69-83`) with `fail-fast: false`; the `ingest` job merges artifacts.
  A house that emits 0 productions still "succeeds" (the job is green) and uploads
  an empty-ish artifact.
- The store's no-delete design (`store.ts:31`) means a 0-production scrape does
  **not** shrink committed data — so this is an **observability** problem, not a
  data-loss one. The fix is a report, not a commit-blocker.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Scrape one house | `bun run scrape-raw oper-frankfurt` | writes raw + (new) appends to health log |
| Build the health report | `bun run scrape-report` (new) | prints per-house counts + flags zeros |
| Typecheck / lint | `bun run typecheck` / `bun run lint` | exit 0 |

## Scope

**In scope** (create/modify):
- `packages/ingest/src/index.ts` — have `runScrapeRaw` record an outcome line
  (slug, productions count, performances count, error?) to a health log file
  (`raw/_health/<slug>.json` or append to `raw/_health.jsonl`), and add a
  `scrape-report` command that reads the health logs and prints a summary,
  exiting non-zero only if `--strict` and a house errored.
- `.github/workflows/scrape.yml` — upload the health logs as an artifact and add a
  job/step that runs `scrape-report` and writes it to `$GITHUB_STEP_SUMMARY`.
- `package.json` — add `"scrape-report"` script.
- A test for the report aggregation (per plan 004's harness, if present).

**Out of scope** (do NOT touch):
- Adapter internals (the `catch`→warn pattern stays — resilience is intentional).
- The commit logic — this plan does not block commits; it reports. (A future plan
  could promote "house errored" to a soft gate.)

## Git workflow

Commit directly to `main`, conventional-commit style. Suggested:
`feat(ingest): per-house scrape health telemetry + report`.

## Steps

### Step 1: Record a per-house outcome from `runScrapeRaw`

After scraping, write a small health record alongside the raw artifact. Target:
`raw/_health/<slug>.json` = `{ slug, productions, performances, ok, error? }`,
where `performances` sums `result.productions[].performances.length`, `ok` is
`productions > 0 && no thrown error`. On a thrown adapter error, still write the
record with `ok: false` and the error message (then rethrow or return per current
behavior — preserve the current exit behavior of the CLI).

**Verify**: `bun run scrape-raw oper-frankfurt` writes both `raw/oper-frankfurt.json`
and `raw/_health/oper-frankfurt.json` with a positive count.

### Step 2: Add the `scrape-report` command

Reads every `raw/_health/*.json`, prints a table sorted by count ascending (zeros
first), and a footer like `N houses, M returned 0, K errored`. Exit 0 by default;
with `--strict`, exit 1 if any house has `ok: false`.

**Verify**: `bun run scrape-report` after scraping ≥1 house prints the summary and
flags any zero-count house.

### Step 3: Surface it in CI

In `scrape.yml`:
- The `scrape` matrix job uploads `raw/_health/<house>.json` as part of (or
  alongside) its artifact.
- The `ingest` job (after downloading artifacts) runs
  `bun run scrape-report >> "$GITHUB_STEP_SUMMARY"` so the run's summary page lists
  every house's count and flags zeros — visible without digging into logs.

**Verify**: YAML diff is limited to the added upload path + the report step;
indentation matches surrounding steps.

## Test plan

If `bun test` exists (plan 004): unit-test the report aggregator — feed it a set
of in-memory health records (some ok, one zero, one errored) and assert the
summary counts and the `--strict` exit decision. Otherwise, the scrape-raw +
scrape-report smoke run in Steps 1–2 is the verification; note that in the index.

## Done criteria

ALL must hold:

- [ ] `bun run scrape-raw <house>` writes a per-house health record
- [ ] `bun run scrape-report` prints per-house counts and flags zero/errored houses
- [ ] CI `scrape.yml` writes the report to the job step summary
- [ ] `bun run typecheck` and `bun run lint` exit 0
- [ ] Changes limited to `packages/ingest/src/index.ts`, `package.json`, `scrape.yml`, and any test file
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- Recording health requires changing the adapter contract (`HouseScrapeResult`)
  or touching adapters — it should not; the count is derivable from the raw result
  in `runScrapeRaw`. If you find yourself editing adapters, stop.
- The `raw/_health/` files would collide with the artifact merge in the `ingest`
  job (`merge-multiple: true`, `pattern: raw-*`) — adjust the path/pattern so
  health files don't get ingested as scrape results, and report the choice.

## Maintenance notes

- This is observability only; it intentionally does not block commits, because the
  no-delete store means a 0-count scrape doesn't lose data. A later plan can decide
  whether a sustained zero-count for an `enabled` house should page someone.
- A natural extension: compare today's per-house count against the committed
  data's count and flag large *relative* drops — but that needs care given the
  additive store (productions don't shrink; new-show counts do). Deferred.
- Reviewer: confirm no adapter file was modified and the health path can't be
  mistaken for a scrape artifact during ingest.
