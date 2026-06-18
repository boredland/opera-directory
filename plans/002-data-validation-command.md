# Plan 002: A `validate` command that guards referential integrity of the committed data

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. When done, update
> this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5cdc985..HEAD -- packages/ingest/src packages/schema/src`
> If `store.ts`, `resolve.ts`, `index.ts`, or `schema/src/types.ts` changed,
> compare the excerpts below against the live code before proceeding; on a
> mismatch treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (consumed by plan 003)
- **Category**: tests
- **Planned at**: commit `5cdc985`, 2026-06-18
- **Issue**: https://github.com/boredland/opera-directory/issues/48

## Why this matters

The product of this repo is the committed JSON graph under `data/` — README §6
sells it as "git-diff-reviewable truth." But **nothing verifies that graph is
internally consistent.** A scraper or resolver regression that emits a
`work_slug`, `person_slug`, `role_slug`, or `production_id` that doesn't exist
in its registry would commit a broken graph, and the only line of defense today
is a human reading the diff. Right now the data is clean (0 dangling references
across ~40k links), so this validator is a **preventive gate**: cheap,
deterministic, and the thing plan 003 runs in CI before the auto-commit. It also
surfaces data-sanity smells (e.g. dates parsed as person names — see plan 006)
as warnings.

## Current state

- The canonical store and its loader: `packages/ingest/src/store.ts`.
  `CanonicalStore.load(dir)` reads `works.json`, `persons.json`, `roles.json`
  (global) and `productions/*.json`, `performances/*.json` (per house) into Maps:
  `store.works`, `store.persons`, `store.roles`, `store.productions`,
  `store.performances` (all keyed by slug/id). **It does NOT load `houses.json`**
  — you will read that file directly in the validator.
- Entity shapes (`packages/schema/src/types.ts`): the reference fields to check are
  - `Production.work_slug → works`, `Production.house_slug → houses`,
    `Production.creative_team[].person_slug → persons`,
    `Production.cast[].person_slug → persons`, `Production.cast[].role_slug → roles`
    (`types.ts:91-113`, `CreativeCredit`/`CastCredit` at `:131-143`)
  - `Performance.production_id → productions`, `Performance.cast[]` (same refs as above)
    (`types.ts:116-127`)
  - `Role.work_slug → works` (`types.ts:57-63`)
  - `Work.composer_slug → persons` **when non-empty** (`composer_slug` is `""`
    for composerless works — empty is valid, not a dangling ref) (`types.ts:36-54`)
- CLI dispatch lives in `packages/ingest/src/index.ts:166-179`
  (`if (import.meta.main)` switches on `cmd`: `scrape-raw`, `ingest-raw`, else `runScrape`).
- `DATA_DIR` is `process.env.DATA_DIR ?? join(process.cwd(), "data")` (`index.ts:101`).
- Repo conventions: small focused modules, exhaustive doc-comment at top of each
  file, `node:fs/promises` for IO (see `store.ts:1`), no external deps for this.
  Match `store.ts` style.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Run the validator | `bun run validate` | prints report; exit 0 when integrity holds |
| Lint | `bun run lint` | exit 0 (run plan 001 first if it fails) |

## Scope

**In scope** (modify/create):
- `packages/ingest/src/validate.ts` (create)
- `packages/ingest/src/index.ts` (add a `validate` CLI branch + export)
- `package.json` (root) — add a `"validate"` script
- `packages/ingest/src/validate.test.ts` (create — see Test plan; only if plan
  004 has set up the test runner, else defer the test file and note it)

**Out of scope** (do NOT touch):
- `store.ts` internals, `resolve.ts`, the data files under `data/` (read-only here).
- CI wiring — that's plan 003.

## Git workflow

Commit directly to `main`, conventional-commit style (see `git log`). Suggested:
`feat(ingest): add validate command for referential integrity + data sanity`.
Do not push/PR unless instructed.

## Steps

### Step 1: Create the validator module

Create `packages/ingest/src/validate.ts`. It loads the store + `houses.json`,
collects every dangling reference (hard **errors**) and a set of data-sanity
**warnings**, and returns them. Target shape:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CanonicalStore } from "./store";

export interface ValidationReport {
  errors: string[];   // dangling references — must be empty for a valid graph
  warnings: string[]; // data-sanity smells — reported, do not fail the build (yet)
  counts: Record<string, number>;
}

/** A person name that is actually a date ("1.1.27", "13.12.26 /") — a scraper bug. */
const DATE_LIKE_NAME = /^\s*\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b/;

export async function validateData(dir: string): Promise<ValidationReport> {
  const store = await CanonicalStore.load(dir);
  const houses = new Set<string>(
    (JSON.parse(await readFile(join(dir, "houses.json"), "utf8")) as { slug: string }[])
      .map((h) => h.slug),
  );
  const errors: string[] = [];
  const warnings: string[] = [];

  const checkPerson = (slug: string | undefined, where: string) => {
    if (slug && !store.persons.has(slug)) errors.push(`${where}: person_slug "${slug}" not in persons.json`);
  };
  const checkRole = (slug: string | undefined, where: string) => {
    if (slug && !store.roles.has(slug)) errors.push(`${where}: role_slug "${slug}" not in roles.json`);
  };

  for (const p of store.productions.values()) {
    if (!store.works.has(p.work_slug)) errors.push(`production ${p.id}: work_slug "${p.work_slug}" not in works.json`);
    if (!houses.has(p.house_slug)) errors.push(`production ${p.id}: house_slug "${p.house_slug}" not in houses.json`);
    for (const c of p.creative_team ?? []) checkPerson(c.person_slug, `production ${p.id} creative`);
    for (const c of p.cast ?? []) { checkPerson(c.person_slug, `production ${p.id} cast`); checkRole(c.role_slug, `production ${p.id} cast`); }
  }
  for (const f of store.performances.values()) {
    if (!store.productions.has(f.production_id)) errors.push(`performance ${f.id}: production_id "${f.production_id}" not in productions`);
    for (const c of f.cast ?? []) { checkPerson(c.person_slug, `performance ${f.id} cast`); checkRole(c.role_slug, `performance ${f.id} cast`); }
  }
  for (const r of store.roles.values()) {
    if (!store.works.has(r.work_slug)) errors.push(`role ${r.slug}: work_slug "${r.work_slug}" not in works.json`);
  }
  for (const w of store.works.values()) {
    if (w.composer_slug && !store.persons.has(w.composer_slug)) errors.push(`work ${w.slug}: composer_slug "${w.composer_slug}" not in persons.json`);
  }

  // Sanity (warnings only): dates minted as people, empty names.
  for (const person of store.persons.values()) {
    if (DATE_LIKE_NAME.test(person.name)) warnings.push(`person "${person.slug}" has a date-like name "${person.name}" (likely a scraper bug)`);
    if (!person.name.trim()) warnings.push(`person "${person.slug}" has an empty name`);
  }

  return {
    errors,
    warnings,
    counts: { ...store.counts(), houses: houses.size, dangling: errors.length, sanity: warnings.length },
  };
}
```

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Wire the `validate` CLI command

In `packages/ingest/src/index.ts`:
- Add `export * from "./validate";` near the other re-exports (`index.ts:16-17`).
- Add a branch in the `import.meta.main` dispatch (`index.ts:166-179`), before the
  final `else`:

```ts
} else if (cmd === "validate") {
  const report = await validateData(DATA_DIR);
  for (const w of report.warnings) console.warn("⚠", w);
  for (const e of report.errors) console.error("✗", e);
  console.log("validate:", report.counts);
  if (report.errors.length) {
    console.error(`\n${report.errors.length} referential-integrity error(s) — the data graph is broken.`);
    process.exit(1);
  }
  console.log(`OK — ${report.counts.persons} persons, ${report.counts.works} works, ${report.warnings.length} sanity warning(s).`);
}
```

Import `validateData` at the top (it's re-exported, but import directly for the
dispatch: add to the existing `./validate` usage or `import { validateData } from "./validate";`).

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Add the npm script

In root `package.json` `scripts`, add: `"validate": "bun packages/ingest/src/index.ts validate"`.

**Verify**: `bun run validate` → prints `OK — …`, exits 0. The report should show
`dangling: 0` and roughly `sanity: 112` warnings (the known date-like persons from
the Staatsoper Hamburg adapter — plan 006 fixes the source). Confirm the exit code
is 0 (warnings do not fail): `bun run validate; echo "exit=$?"` → `exit=0`.

## Test plan

If plan 004 has set up `bun test`, add `packages/ingest/src/validate.test.ts`:
- A store fixture with one valid production+performance → `errors` is empty.
- A production with a `work_slug` absent from the works set → exactly one error
  naming that slug.
- A performance with a `production_id` absent from productions → one error.
- A person named `"13.12.26"` → one sanity warning, **no** error.
- A work with `composer_slug: ""` → no error (empty is valid).
Model the test structure after the resolver tests created in plan 004.

If plan 004 is not yet done: skip the test file, and in `plans/README.md` note
that 002's tests are deferred until 004. The `bun run validate` smoke check in
Step 3 is the interim verification.

## Done criteria

ALL must hold:

- [ ] `packages/ingest/src/validate.ts` exists and exports `validateData`
- [ ] `bun run validate` exits 0 on current data, prints `dangling: 0`
- [ ] Manually breaking one reference (temporarily edit a copy, or a unit test)
      makes `validateData` return a non-empty `errors` array and the CLI exit 1
- [ ] `bun run typecheck` exits 0; `bun run lint` exits 0
- [ ] No `data/` file is modified (`git status` shows only `packages/ingest/**` and `package.json`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- `CanonicalStore.load` no longer exposes `works`/`persons`/`roles`/`productions`/
  `performances` Maps or `counts()` as described (the store was refactored).
- `bun run validate` reports `dangling > 0` on **unmodified** committed data —
  that means a real integrity break exists now; report the specific errors rather
  than "fixing" data, since the root cause is upstream (a scraper/resolver bug).
- `houses.json` is not an array of `{ slug }` objects.

## Maintenance notes

- Plan 003 runs `bun run validate` in CI **before** the auto-commit, so a broken
  graph fails the pipeline instead of landing on `main`.
- Once plan 006 removes the date-like persons, consider promoting the
  `DATE_LIKE_NAME` warning to a hard error (move it into `errors`) so the class
  can never reappear. Leave it as a warning until then or CI will be red.
- When new entity types or reference fields are added to the schema, add the
  corresponding check here — this validator is the schema's referential contract.
