# Plan 008: Extract shared date/credit parsing helpers and pilot-migrate a handful of adapters

> **Executor instructions**: This is a spike + pilot, not a fleet-wide rewrite.
> Follow step by step; run every verification command and confirm the result
> before moving on. If a STOP condition occurs, stop and report. When done,
> update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5cdc985..HEAD -- packages/scrapers/src`

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/004-core-resolver-store-tests.md (a test harness must exist so the new helpers ship with unit tests)
- **Category**: tech-debt
- **Planned at**: commit `5cdc985`, 2026-06-18
- **Issue**: https://github.com/boredland/opera-directory/issues/54

## Why this matters

There are ~197 house adapters in `packages/scrapers/src/houses/`. Each re-implements
the same shapes: a listing → detail → parse flow, a bespoke date parser, and a
local credit-label map. The most error-prone duplication is **date parsing**:
adapters hand-roll regexes with divergent component ordering and month handling,
and at least one (`staatsoper-hamburg`, see plan 006) parses dates as names. A bug
or a new edge case must be fixed in N copies. This plan does the *safe* slice of
de-duplication: extract well-tested shared helpers for the highest-frequency
patterns and migrate a small pilot set, proving byte-identical scrape output, so a
later effort can roll them out fleet-wide with confidence. It deliberately does
**not** rewrite all 197 adapters.

## Current state

- Shared helpers already exist and are adopted unevenly:
  `packages/scrapers/src/houses/_german-credits.ts` (`normalizeGermanCredit`),
  `_calendar-cms.ts`, `_schedule-cms.ts`, `_theater-cms.ts`. Many adapters parse
  inline instead of using them.
- Bespoke date parsing examples (read these to find the common shapes):
  - German `dd.mm.yy`: `staatsoper-hamburg.ts:64` —
    `/(\d{1,2})\.(\d{1,2})\.(\d{2})\b/` then
    `` `20${dm[3]}-${dm[2].padStart(2,"0")}-${dm[1].padStart(2,"0")}` ``.
  - French month-name dates and others appear across the France/Italy adapters
    (e.g. the recently-added `opera-de-lille.ts`, `opera-national-du-capitole.ts`).
  - `~190` `padStart`-based date assembly sites exist across adapters (reported by
    audit; verify with a grep before scoping the pilot).
- Credit-label maps are per-adapter (German in `_german-credits.ts`; Italian/
  English/Russian maps defined locally in individual adapters).
- No fetch-level shared `parseGermanDate` / `parseFrenchDate` / `monthName→number`
  helper exists in `fetch.ts`.
- Verification today is `bun run typecheck` + `bun run scrape-raw <slug>` (compare
  output before/after). After plan 004, `bun test` is available for unit tests.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Find date-parse sites | `grep -rln "padStart" packages/scrapers/src/houses` | list of adapters (scoping input) |
| Scrape one house | `bun run scrape-raw <slug>` | writes `raw/<slug>.json` |
| Tests | `bun test packages/scrapers` | all pass |
| Typecheck / lint | `bun run typecheck` / `bun run lint` | exit 0 |

## Scope

**In scope** (create/modify):
- A new shared module, e.g. `packages/scrapers/src/houses/_dates.ts` (or extend
  `fetch.ts`) exporting tested helpers: `monthToNumber(name, lang)`,
  `germanDate(dd, mm, yy)`, `isoFromParts(y, m, d)`, and a `DATE_LIKE` guard.
- Its test file (`_dates.test.ts`).
- **Pilot migration of 3–5 adapters only** — pick ones whose date parsing maps
  cleanly onto the new helpers (good candidates: `staatsoper-hamburg.ts` if plan
  006 hasn't already, plus 2–4 German `dd.mm.yy` adapters identified via the grep).

**Out of scope** (do NOT touch in this plan):
- The other ~190 adapters — fleet-wide rollout is a follow-up once the helpers are
  proven. Migrating more here balloons risk and review surface.
- The listing→detail→parse control flow (a generic adapter template is a separate,
  bigger design effort — do not attempt it here).
- Credit-label consolidation — note it as a follow-up; don't bundle it in.

## Git workflow

Commit directly to `main`, conventional-commit style. Suggested commits:
1. `feat(scrapers): shared date-parsing helpers + tests`
2. `refactor(scrapers): migrate <pilot houses> to shared date helpers`
Keep the helper commit separate from the migration so a regression bisects cleanly.

## Steps

### Step 1: Scope the pilot from real data

Run `grep -rln "padStart" packages/scrapers/src/houses` and skim ~10 hits to
identify the 2–3 most common date shapes (German `dd.mm.yy`, French/Italian
month-name). Pick 3–5 adapters using the **same** shape for the pilot. Record the
chosen list in the commit message and the index.

**Verify**: you have a written list of 3–5 pilot adapters sharing one date shape.

### Step 2: Write the shared helpers with tests first

Create `_dates.ts` with small pure functions covering the chosen shape(s). Write
`_dates.test.ts` (uses `"bun:test"`) covering: valid `dd.mm.yy` → ISO; zero-pad;
2-digit-year → `20yy`; month names per supported language; an invalid/empty input
→ `null`; the `DATE_LIKE` guard matches `"1.1.27"` and rejects `"Mozart"`.

**Verify**: `bun test packages/scrapers` → the new tests pass; `bun run typecheck` → 0.

### Step 3: Migrate the pilot adapters, proving byte-identical output

For each pilot adapter, capture baseline output first, then refactor to call the
helpers, then diff:

```
bun run scrape-raw <slug>            # baseline
cp raw/<slug>.json /tmp/<slug>.before.json
# ...refactor the adapter to use _dates helpers...
bun run scrape-raw <slug>
diff /tmp/<slug>.before.json raw/<slug>.json && echo "IDENTICAL"
```

The refactor must be behavior-preserving: the diff is empty. If a diff appears,
either the helper differs from the old parser (fix the helper) or the old parser
had a bug the helper fixes (acceptable — but document the specific change in
NOTES and confirm it's a correction, not a regression).

**Verify**: each pilot adapter's before/after scrape-raw is identical (or any diff
is a documented, intended correction); `bun run typecheck` and `bun run lint` → 0.

## Test plan

- `_dates.test.ts`: unit cases per Step 2.
- Per-adapter regression: the before/after `scrape-raw` diff in Step 3 is the
  integration check (network-dependent — if a host is down, note it and rely on
  the unit tests + static review for that adapter).

## Done criteria

ALL must hold:

- [ ] `_dates.ts` exists with unit tests that pass (`bun test packages/scrapers`)
- [ ] 3–5 pilot adapters call the shared helpers; each one's `scrape-raw` output is
      byte-identical to baseline (or any diff is documented as an intended fix)
- [ ] `bun run typecheck` and `bun run lint` exit 0
- [ ] No adapter outside the pilot list was modified (`git status`)
- [ ] `plans/README.md` status row updated, with the pilot list and a note that
      fleet-wide rollout is a follow-up

## STOP conditions

Stop and report if:

- The pilot adapters don't actually share a date shape closely enough for one
  helper (re-scope to fewer adapters rather than forcing a god-helper).
- A before/after diff is non-empty and you can't determine whether it's a fix or a
  regression — stop and report the diff; do not commit a behavior change blind.
- The refactor tempts you outside date parsing (control flow, credit maps) — that's
  out of scope; stop and note it as a follow-up.

## Maintenance notes

- This is the proof-of-concept for fleet-wide consolidation. Once the helpers are
  trusted, a follow-up plan can migrate the remaining ~190 adapters in batches,
  each batch gated by the same before/after scrape-raw diff.
- Credit-label map consolidation (Italian/English/Russian maps → a shared
  `_credit-labels.ts` keyed by language, mirroring `_german-credits.ts`) is the
  obvious next de-duplication; deliberately deferred here to keep the diff small.
- Reviewer: scrutinize that "byte-identical output" was actually verified per
  adapter, not assumed — this is where a refactor silently breaks a house.
