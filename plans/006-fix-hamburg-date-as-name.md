# Plan 006: Staatsoper Hamburg adapter stops minting performance dates as cast/crew people

> **Executor instructions**: Follow step by step; run every verification command
> and confirm the result before moving on. If a STOP condition occurs, stop and
> report. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5cdc985..HEAD -- packages/scrapers/src/houses/staatsoper-hamburg.ts`
> If it changed, compare the excerpt below against live code before editing.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (plan 002's sanity check detects this class; plan 005's prune clears the resulting orphans)
- **Category**: bug
- **Planned at**: commit `5cdc985`, 2026-06-18
- **Issue**: https://github.com/boredland/opera-directory/issues/52

## Why this matters

The Staatsoper Hamburg adapter parses performance dates as **people**: the
canonical graph contains 112 junk `Person` entities with date names like
`"1.1.27"` / `"13.12.26 /"` and bogus professions `["conductor","singer"]`,
referenced by 161 cast + 60 creative credits on Hamburg productions. Every one
is a scraper artifact — a date string that leaked into a `<span>` the adapter
treats as a credit name. This corrupts the persons graph and any future
person-centric view. The fix is small and local to one adapter; once it lands,
the junk persons orphan and plan 005's `prune` removes them.

## Current state

- `packages/scrapers/src/houses/staatsoper-hamburg.ts` — `parseInfos(html)`
  (`:124-144`) extracts credits from `production-infos__item` blocks: for each
  `<div class="label">…</div><div class="content…">…</div>` it pulls every
  `<span>Name</span>` as a credit name, then `normalizeGermanCredit(label, name)`
  routes it to `creative_team` (if the label maps to a function) or `cast`
  (otherwise). The current name guard only drops empties:
  ```ts
  for (const nm of (m[2] ?? "").matchAll(/<span>([\s\S]*?)<\/span>/g)) {
    const name = stripHtml(nm[1] ?? "");
    const key = `${label}|${name}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const credit = normalizeGermanCredit(label, name);
    if (credit.function) creative_team.push(credit);
    else cast.push(credit);
  }
  ```
  A `<span>` holding a date (e.g. from a "Termine"/schedule info-item) passes this
  guard and becomes a credit → a date-named Person at ingest.
- The calendar parser already knows Hamburg's date format: `dd.mm.yy`
  (`parseCalendar` `:64`, regex `/(\d{1,2})\.(\d{1,2})\.(\d{2})\b/`). Dates are the
  source of truth from the calendar, never from the infos list.
- Resolver behavior: cast credits need a `role` (`resolve.ts:131`) — but these
  junk names got `role`/`function` from `normalizeGermanCredit`, so they passed
  through and were minted. The faithful fix is to never emit a date as a name.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Re-scrape Hamburg (validation) | `bun run scrape-raw staatsoper-hamburg` | prints production count, writes `raw/staatsoper-hamburg.json` |
| Typecheck / lint | `bun run typecheck` / `bun run lint` | exit 0 |

## Scope

**In scope** (modify):
- `packages/scrapers/src/houses/staatsoper-hamburg.ts` (the `parseInfos` guard)

**Out of scope** (do NOT touch):
- `_german-credits.ts`, the calendar/date parsing, other adapters.
- The committed `data/` junk — it clears via re-scrape + plan 005 prune, not by
  hand-editing here.

## Git workflow

Commit directly to `main`, conventional-commit style. Suggested:
`fix(scrapers): staatsoper-hamburg — don't parse performance dates as credit names`.

## Steps

### Step 1: Add a date-like-name guard in `parseInfos`

Add a module-level constant and one guard line so a date-shaped `<span>` value is
never emitted as a credit. Target:

```ts
/** A "name" that is actually a date ("1.1.27", "13.12.26", "13.12.2026 /") — not a person. */
const DATE_LIKE_NAME = /^\s*\d{1,2}\.\d{1,2}\.\d{2,4}\b/;
```

In the `parseInfos` loop, extend the skip condition:

```ts
    const name = stripHtml(nm[1] ?? "");
    const key = `${label}|${name}`;
    if (!name || DATE_LIKE_NAME.test(name) || seen.has(key)) continue;
```

### Step 2: Investigate whether an entire info-item label should be excluded

Re-scrape and inspect: it's likely the dates come from a single labelled item
(e.g. "Termine", "Vorstellungen", "Dauer"). Run
`bun run scrape-raw staatsoper-hamburg`, then inspect the raw output for any
remaining suspicious cast/creative entries:

```
bun run scrape-raw staatsoper-hamburg
# then check no cast/creative name is date-like or otherwise junk:
grep -oE '"(role|function)"[^}]*"name"[^}]*' raw/staatsoper-hamburg.json | grep -E '[0-9]{1,2}\.[0-9]{1,2}\.' || echo "no date-like names"
```

If date-like names are gone but other junk remains under one specific label, add
that label to an exclusion set in `parseInfos` (e.g. skip the block when
`/^(Termine|Vorstellungen|Dauer|Einf[üu]hrung)/i.test(label)`), and document why.
If only dates were the problem, Step 1 suffices.

**Verify**: the grep above prints `no date-like names`.

### Step 3: Confirm credits still extract for a real production

Spot-check the raw output: a known Hamburg opera production still has real
`creative_team` (e.g. a `conductor`/`director`) and `cast` (singer→role) entries —
i.e. the guard didn't over-filter real names.

**Verify**: `bun run typecheck` → 0; `bun run lint` → 0; the raw file shows
non-empty, plausibly-named creative/cast for at least one opera production.

## Test plan

If `bun test` is set up (plan 004), add a focused unit test (Bun can import the
adapter's non-exported helpers only if exported — otherwise test at the
`parseInfos` level by exporting it for test, or skip and rely on the scrape-raw
grep). Minimum: a fixture HTML snippet with a `production-infos__item` containing
a date `<span>` and a real-name `<span>` → only the real name becomes a credit.
If exporting `parseInfos` purely for tests is undesirable, document that the
scrape-raw grep in Step 2 is the regression check and note it in `plans/README.md`.

## Done criteria

ALL must hold:

- [ ] `staatsoper-hamburg.ts` skips date-like `<span>` values in `parseInfos`
- [ ] `bun run scrape-raw staatsoper-hamburg` produces a raw file whose cast/creative
      names contain **no** date-like strings (the Step 2 grep prints the success line)
- [ ] A real opera production in the raw output still has non-empty creative + cast
- [ ] `bun run typecheck` and `bun run lint` exit 0
- [ ] Only `staatsoper-hamburg.ts` changed (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- After Step 1 the scrape still emits date-like names — the dates come from a
  different code path than `parseInfos` (re-read the adapter and report where).
- The host `die-hamburgische-staatsoper.de` is unreachable from the runner so you
  can't validate via scrape-raw — report it; the static change is still correct,
  but mark the runtime verification as blocked rather than claiming it passed.
- The guard removes real credits (over-filtering) — report and narrow the regex.

## Maintenance notes

- After this lands, run a Hamburg backfill (CI: dispatch `scrape.yml` with
  `houses=staatsoper-hamburg backfill=true`) so the re-resolved productions drop
  their date-person credits, then run plan 005's `prune` to delete the orphaned
  junk persons.
- Plan 002's `DATE_LIKE_NAME` sanity warning should drop to ~0 once this is done;
  that's the signal to promote it to a hard error (plan 002 maintenance note).
- Consider whether other calendar-driven adapters share the pattern of pulling
  `<span>`s from an infos list that includes a dates block — a quick audit grep
  for date-like names across all `raw/*.json` after a full scrape would tell.
