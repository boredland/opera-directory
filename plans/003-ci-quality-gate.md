# Plan 003: CI runs typecheck/lint on every push and validates data before auto-committing

> **Executor instructions**: Follow step by step; run every verification command
> and confirm the expected result before moving on. If a STOP condition occurs,
> stop and report. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5cdc985..HEAD -- .github/workflows package.json`
> If `.github/workflows/scrape.yml` changed, compare the excerpts below against
> the live file before editing; on a mismatch treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-fix-lint-baseline.md (lint must be green), plans/002-data-validation-command.md (`bun run validate` must exist)
- **Category**: ci
- **Planned at**: commit `5cdc985`, 2026-06-18
- **Issue**: https://github.com/boredland/opera-directory/issues/49

## Why this matters

The only CI workflow, `.github/workflows/scrape.yml`, runs
prepare → scrape → ingest → **commit data** with **zero quality gates**: no
typecheck, no lint, and no data validation before `git push`
(`scrape.yml:102-110`). A type error, a lint regression, or a scraper bug that
corrupts the canonical graph lands on `main` unnoticed — and the committed JSON
is the product. This plan adds (a) a push/PR `ci` workflow running typecheck +
lint + validate, and (b) a `validate` step in the existing ingest job so a
broken graph fails the run instead of being committed.

## Current state

- `.github/workflows/scrape.yml` — triggers: `schedule` (daily 04:00 UTC) and
  `workflow_dispatch` (`scrape.yml:3-17`). Jobs: `prepare` (build house matrix),
  `scrape` (per-house matrix, `max-parallel: 6`, runs `bun run scrape-raw`),
  `ingest` (downloads raw artifacts, `bun run ingest-raw`, then the commit step at
  `scrape.yml:103-113`). No push/pull_request trigger, no typecheck/lint anywhere.
- The ingest job's commit step (`scrape.yml:104-113`):
  ```yaml
  - run: bun run ingest-raw
  - name: Commit regenerated canonical store
    run: |
      git config user.name "github-actions[bot]"
      git config user.email "github-actions[bot]@users.noreply.github.com"
      if [ -n "$(git status --porcelain data)" ]; then
        git add data
        git commit -m "data: scrape ${{ github.event.inputs.houses || 'all enabled' }} [skip ci]"
        git push
      fi
  ```
- Setup pattern used in the repo (copy it exactly): `actions/checkout@v5`,
  `oven-sh/setup-bun@v2` with `bun-version: latest`, then `bun install --frozen-lockfile`
  (`scrape.yml:62-66`).
- Verification commands (root `package.json:13-14`): `bun run typecheck`
  (`bun --filter '*' typecheck`), `bun run lint` (`biome check .`), and
  `bun run validate` (added by plan 002).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Validate data | `bun run validate` | exit 0, `dangling: 0` |
| Lint the new YAML (optional) | `bunx biome check .github/workflows/ci.yml` | n/a if Biome ignores YAML |

## Scope

**In scope** (create/modify):
- `.github/workflows/ci.yml` (create)
- `.github/workflows/scrape.yml` (add one `validate` step in the `ingest` job, before the commit step)

**Out of scope** (do NOT touch):
- The `scrape` matrix job, `max-parallel`, concurrency groups, retention — unrelated.
- Any source or data file.

## Git workflow

Commit directly to `main`, conventional-commit style. Suggested:
`ci: add typecheck/lint/validate gate and validate data before auto-commit`.
Do not push/PR unless instructed.

## Steps

### Step 1: Add the push/PR quality workflow

Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run validate
```

`bun run validate` here checks the committed data on the branch (catches a
hand-edit or a bad merge that breaks integrity).

**Verify locally** (the CI steps mirror local commands):
`bun run typecheck && bun run lint && bun run validate` → all exit 0.

### Step 2: Validate freshly-ingested data before the auto-commit

In `.github/workflows/scrape.yml`, in the `ingest` job, insert a validate step
**between** `- run: bun run ingest-raw` and the "Commit regenerated canonical
store" step:

```yaml
      - run: bun run ingest-raw
      - name: Validate the regenerated graph
        run: bun run validate
      - name: Commit regenerated canonical store
        run: |
          ...
```

Because `bun run validate` exits 1 on any dangling reference, a corrupting
scrape now fails the job and the broken data is never committed.

**Verify**: the YAML is well-formed — `git diff .github/workflows/scrape.yml`
shows only the inserted step; indentation matches the surrounding steps (6 spaces
for `- name:` under `steps:`).

### Step 3: Confirm the gate would actually catch a regression (local dry-run)

Simulate a broken graph locally without committing: in a scratch copy of the data
dir, that's heavy — instead rely on plan 002's unit/smoke proof that `validate`
exits 1 on a dangling reference. Re-run `bun run validate` on the real data to
confirm it currently exits 0 (so the gate is green on a good graph).

**Verify**: `bun run validate; echo "exit=$?"` → `exit=0`.

## Test plan

No unit tests (CI YAML). Verification is:
- Local: `bun run typecheck && bun run lint && bun run validate` all green.
- After pushing (operator's call): the `ci` workflow appears on the push and
  passes; the next scheduled/dispatched `scrape` run shows the new "Validate the
  regenerated graph" step succeeding before the commit. Confirm via
  `gh run list --workflow=ci.yml` and `gh run view <id>`.

## Done criteria

ALL must hold:

- [ ] `.github/workflows/ci.yml` exists with typecheck + lint + validate steps on push and pull_request
- [ ] `scrape.yml` ingest job runs `bun run validate` before the commit step
- [ ] `bun run typecheck`, `bun run lint`, `bun run validate` all exit 0 locally
- [ ] Only `.github/workflows/ci.yml` and `.github/workflows/scrape.yml` changed (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- `bun run lint` is not green (plan 001 not done) or `bun run validate` does not
  exist (plan 002 not done) — dependencies unmet; do not weaken the workflow to
  make it pass.
- `bun run validate` exits non-zero on the current committed data — a real
  integrity break exists; report it, do not remove the gate.
- The `scrape.yml` ingest job structure differs from the excerpt (e.g. the commit
  step was renamed/moved) such that you can't insert the validate step cleanly.

## Maintenance notes

- This is the gate the whole "diff-reviewable JSON" promise relies on; keep
  `validate` ahead of the commit step in any future `scrape.yml` refactor.
- If `bun --filter '*' typecheck` becomes slow as packages grow, consider caching
  Bun's install in CI; not needed at current size.
- When plan 006 lands and the date-like-name sanity check is promoted to a hard
  error (plan 002 maintenance note), the `validate` step here will start failing
  on any reintroduced junk — that's intended.
