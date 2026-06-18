# Plan 001: Lint and format gate passes clean, Biome config matches the CLI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5cdc985..HEAD -- packages/scrapers/src/houses biome.json`
> If any in-scope file changed since this plan was written, run `bun run lint`
> yourself and compare the live violation set against the list below; on a
> mismatch, re-derive the fix list from the live output but keep the same approach.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `5cdc985`, 2026-06-18
- **Issue**: https://github.com/boredland/opera-directory/issues/55

## Why this matters

`bun run lint` (the repo's only style/quality command besides typecheck)
currently **exits 1**: 5 auto-fixable lint violations plus ~12 formatter
violations across house adapters, and the Biome config schema version is pinned
behind the installed CLI. A red lint gate cannot be wired into CI (see plan
003), and it trains contributors to ignore lint output. This plan makes
`bun run lint` exit 0 with no behavior change, so a CI gate becomes possible.

## Current state

- `biome.json:2` — `"$schema": "https://biomejs.dev/schemas/2.0.0/schema.json"`
  but the installed CLI is 2.4.x, producing a schema-mismatch warning on every run.
- `bun run lint` is `biome check .` (see root `package.json:14`). Current failures
  (from `bunx biome check .`):
  - `packages/scrapers/src/houses/armenian-national-opera.ts:174` — `lint/complexity/noUselessEscapeInRegex` (FIXABLE)
  - `packages/scrapers/src/houses/opera-collective-ireland.ts:225` — `lint/style/useTemplate` (FIXABLE)
  - `packages/scrapers/src/houses/bolshoi-theatre.ts:5` — `lint/correctness/noUnusedImports` (FIXABLE)
  - `packages/scrapers/src/houses/estonian-national-opera.ts:94` — `lint/complexity/useOptionalChain` (FIXABLE)
  - `packages/scrapers/src/houses/staatstheater-augsburg.ts:51` — `lint/complexity/useOptionalChain` (FIXABLE)
  - ~12 "Formatter would have printed…" violations across additional adapter files
    (line-wrapping only; Biome's formatter is the source of truth, `lineWidth: 100`).
- Repo conventions: Biome 2.x for both lint and format; 2-space indent, double
  quotes, `lineWidth: 100` (see `biome.json`). All fixes here are mechanical.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Lint (check) | `bun run lint` | exit 0, no errors (the goal) |
| Auto-fix lint+format | `bunx biome check --write .` | applies fixes, exit 0 |
| Migrate config schema | `bunx biome migrate --write` | rewrites `biome.json` schema/version |
| Typecheck | `bun run typecheck` | exit 0 |

## Scope

**In scope** (modify only):
- `biome.json` (schema/version migration only)
- The adapter files Biome auto-fixes under `packages/scrapers/src/houses/` (the
  5 lint sites above + the ~12 formatter sites Biome reports).

**Out of scope** (do NOT touch):
- Any source change beyond what `biome check --write` and `biome migrate --write`
  produce. Do **not** hand-edit logic, rename symbols, or "tidy" anything.
- `package.json` scripts (CI wiring is plan 003).

## Git workflow

The repo commits directly to `main` with conventional-commit messages (see
`git log`: `fix(scrapers): …`, `feat(fr): …`). Do not open a PR or push unless
the operator instructs it.

- Suggested commit: `style(scrapers): fix Biome lint + format violations; migrate config`

## Steps

### Step 1: Migrate the Biome config to the installed CLI version

Run `bunx biome migrate --write`. This updates `biome.json`'s `$schema` and any
renamed options to match the installed 2.4.x CLI.

**Verify**: `git diff biome.json` shows only schema/version/option-rename
changes (no rule disabled, no `recommended` flipped off). → If a rule is
disabled or `linter.rules.recommended` changes, that's a STOP condition.

### Step 2: Auto-fix all lint + format violations

Run `bunx biome check --write .`. This fixes the 5 lint violations
(noUselessEscapeInRegex, useTemplate, noUnusedImports, useOptionalChain ×2) and
reformats the ~12 files with formatter violations.

**Verify**: `bun run lint` → exit 0, "No fixes applied" / no errors.

### Step 3: Eyeball the semantic auto-fixes

The format-only changes are safe. Read the diff for the four non-format fixes to
confirm Biome didn't change matching behavior:
- `armenian-national-opera.ts:174` — confirm the removed regex escape was
  genuinely redundant (e.g. `\/` → `/` outside a char class, `\-` at an edge).
  The matched set must be identical.
- `bolshoi-theatre.ts:5` — confirm the removed import was truly unused
  (`grep -n "<ImportedName>" packages/scrapers/src/houses/bolshoi-theatre.ts`
  returns no other use).
- `opera-collective-ireland.ts:225` (template literal) and the two
  `useOptionalChain` fixes — confirm the expression is equivalent.

**Verify**: `bun run typecheck` → exit 0.

## Test plan

No unit tests (the repo has none yet; that's plan 004). Verification is the lint
and typecheck gates plus the manual diff review in Step 3. As a behavior smoke
check for the regex change, run the affected adapter's light validation:
`bun run scrape-raw armenian-national-opera` → exits without throwing and prints
a production count (network permitting; if the host is unreachable, note it and
rely on Step 3's static review).

## Done criteria

ALL must hold:

- [ ] `bun run lint` exits 0
- [ ] `bun run typecheck` exits 0
- [ ] `git diff 5cdc985..HEAD -- biome.json` shows no rule was disabled and
      `recommended` is still true
- [ ] No files outside `biome.json` and `packages/scrapers/src/houses/` are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report (do not improvise) if:

- `biome migrate` or `biome check --write` disables a lint rule, flips
  `recommended`, or changes formatter width/quote settings.
- `biome check --write` modifies files outside `packages/scrapers/src/houses/`
  and `biome.json` (e.g. it reformats `data/` JSON or core pipeline files) —
  report the unexpected files; do not commit them.
- The regex auto-fix in `armenian-national-opera.ts` changes which strings the
  pattern matches (verify in Step 3).
- Typecheck fails after the fixes.

## Maintenance notes

- Plan 003 wires `bun run lint` into CI; this plan is its prerequisite.
- A reviewer should confirm the diff is overwhelmingly whitespace/wrapping plus
  the four named semantic fixes — nothing else.
- Keep `biome.json`'s `$schema` version in lockstep with future
  `@biomejs/biome` bumps to avoid the mismatch warning recurring.
