# Plan 005: A `prune` command removes zero-reference global entities (dry-run by default)

> **Executor instructions**: Follow step by step; run every verification command
> and confirm the result before moving on. If a STOP condition occurs, stop and
> report. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5cdc985..HEAD -- packages/ingest/src`
> If `store.ts` changed, compare the excerpts below against live code first.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-data-validation-command.md (reuses the reference-collection traversal and the `validate` gate to prove no dangling refs after a prune)
- **Category**: tech-debt
- **Planned at**: commit `5cdc985`, 2026-06-18
- **Issue**: https://github.com/boredland/opera-directory/issues/51

## Why this matters

The store is insert-or-merge and **never deletes** (`store.ts:31`,
"NEVER deletes"). That's correct for performances (history accumulates as nights
roll out of the live window), but it means **global entities orphan and
accumulate forever**: when a re-scrape or resolver change re-keys a work/person/
role, the old slug lingers with zero inbound references. There are currently
**138 orphan persons, 46 orphan works, 197 orphan roles** (measured over `data/`),
including 112 junk date-like persons (plan 006 fixes the source). They pollute
search/index space and the cross-house graph. A maintainer hit this manually when
deduplicating a house's works. This plan adds a safe, reviewable `prune` command —
dry-run by default — to garbage-collect unreferenced global entities.

## Current state

- Global entities live in `data/works.json`, `data/persons.json`, `data/roles.json`
  (arrays, sorted by slug). Per-house `data/productions/*.json` and
  `data/performances/*.json` reference them.
- `CanonicalStore` (`store.ts`): `new CanonicalStore()` is constructible;
  `static load(dir)` populates the Maps; `save(dir)` writes all files
  deterministically (sorted by slug/id, null-stripped — `store.ts:114-137`,
  `clean` `:235-246`). Re-saving unchanged data is byte-identical (idempotent).
- A global entity is **referenced** iff:
  - Person: appears as a `person_slug` in any production/performance
    `creative_team`/`cast`, **or** is a `Work.composer_slug`.
  - Role: appears as a `role_slug` in any production/performance `cast`.
  - Work: is a `Production.work_slug`, **or** is the `work_slug` of a *referenced* role.
- **Productions/performances are NOT pruned** — an orphan production (a future
  show with no performances yet, 142 of them) is valid data, not garbage.
- Reference fields: `types.ts` (`Production` `:91-113`, `Performance` `:116-127`,
  `Role` `:57-63`, `Work.composer_slug` `:43`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Prune (dry-run) | `bun run prune` | prints orphan counts + samples, writes nothing |
| Prune (apply) | `bun run prune --apply` | removes orphans, rewrites global files |
| Validate after | `bun run validate` | exit 0, `dangling: 0` |
| Tests | `bun test packages/ingest` | all pass |
| Typecheck / lint | `bun run typecheck` / `bun run lint` | exit 0 |

## Scope

**In scope** (create/modify):
- `packages/ingest/src/prune.ts` (create)
- `packages/ingest/src/index.ts` (add a `prune` CLI branch + export)
- `package.json` (root) — add `"prune": "bun packages/ingest/src/index.ts prune"`
- `packages/ingest/src/prune.test.ts` (create — see Test plan)
- When run with `--apply`: `data/works.json`, `data/persons.json`, `data/roles.json`
  (data change — the point of the command; commit separately, see Git workflow)

**Out of scope** (do NOT touch):
- `data/productions/*.json`, `data/performances/*.json` — never pruned.
- `store.ts` internals.

## Git workflow

Commit directly to `main`, conventional-commit style. Two commits:
1. `feat(ingest): add prune command for orphan global entities` (code only).
2. `data: prune NN orphan works/persons/roles [skip ci]` (the data change from
   `--apply`) — only after a human reviews the dry-run list. The `[skip ci]` tag
   matches the repo's data-commit convention (`scrape.yml:109`).

## Steps

### Step 1: Implement the prune module

Create `packages/ingest/src/prune.ts`. Compute referenced sets, derive orphans,
and (only with `apply`) delete them from the store Maps and re-save. Target shape:

```ts
import { CanonicalStore } from "./store";

export interface PruneReport {
  orphans: { persons: string[]; works: string[]; roles: string[] };
  counts: Record<string, number>;
}

export async function prune(dir: string, apply: boolean): Promise<PruneReport> {
  const store = await CanonicalStore.load(dir);

  const refPersons = new Set<string>();
  const refRoles = new Set<string>();
  const refWorks = new Set<string>();
  const addCredits = (cast?: { person_slug?: string; role_slug?: string }[],
                      crew?: { person_slug?: string }[]) => {
    for (const c of cast ?? []) { if (c.person_slug) refPersons.add(c.person_slug); if (c.role_slug) refRoles.add(c.role_slug); }
    for (const c of crew ?? []) if (c.person_slug) refPersons.add(c.person_slug);
  };
  for (const p of store.productions.values()) { refWorks.add(p.work_slug); addCredits(p.cast, p.creative_team); }
  for (const f of store.performances.values()) addCredits(f.cast);
  for (const w of store.works.values()) if (w.composer_slug) refPersons.add(w.composer_slug);
  // A work is "used" if a referenced role belongs to it.
  for (const r of store.roles.values()) if (refRoles.has(r.slug)) refWorks.add(r.work_slug);

  const orphans = {
    persons: [...store.persons.keys()].filter((s) => !refPersons.has(s)).sort(),
    roles: [...store.roles.keys()].filter((s) => !refRoles.has(s)).sort(),
    works: [...store.works.keys()].filter((s) => !refWorks.has(s)).sort(),
  };

  if (apply) {
    for (const s of orphans.persons) store.persons.delete(s);
    for (const s of orphans.roles) store.roles.delete(s);
    for (const s of orphans.works) store.works.delete(s);
    await store.save(dir);
  }

  return {
    orphans,
    counts: {
      orphan_persons: orphans.persons.length,
      orphan_roles: orphans.roles.length,
      orphan_works: orphans.works.length,
    },
  };
}
```

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Wire the CLI + script

In `index.ts`: add `export * from "./prune";`, and a dispatch branch:

```ts
} else if (cmd === "prune") {
  const apply = rest.includes("--apply"); // or process.argv.includes
  const report = await prune(DATA_DIR, apply);
  console.log("orphans:", report.counts);
  for (const [kind, list] of Object.entries(report.orphans)) {
    if (list.length) console.log(`  ${kind} (${list.length}): ${list.slice(0, 10).join(", ")}${list.length > 10 ? " …" : ""}`);
  }
  console.log(apply ? "pruned + saved." : "dry-run — pass --apply to remove.");
}
```

Add `"prune"` script to root `package.json`.

**Verify**: `bun run prune` (dry-run) → prints `orphan_persons`, `orphan_roles`,
`orphan_works` counts (~138 / ~197 / ~46) and sample slugs; `git status` shows
**no** data change.

### Step 3: Apply, then prove integrity is intact

Review the dry-run orphan list (a human should confirm nothing valuable is in it —
note that future productions with no performances are NOT in this list because
they aren't global entities). Then:

`bun run prune --apply` → removes orphans, rewrites the 3 global files.

**Verify**: `bun run validate` → exit 0, `dangling: 0` (pruning only
zero-reference entities cannot create a dangling reference; validate confirms).
Confirm `git status` shows changes limited to `data/works.json`,
`data/persons.json`, `data/roles.json` (plus possibly re-canonicalized per-house
files — see STOP conditions).

## Test plan

`packages/ingest/src/prune.test.ts` (uses `"bun:test"`, structure per plan 004):
- Build a `new CanonicalStore()` with: 1 work referenced by 1 production, 1 work
  referenced by no production and no cast role (orphan), 1 person who is a
  composer of a kept work (referenced), 1 person in no credit (orphan), 1 role
  cast in a production (referenced), 1 role never cast (orphan).
- `prune(dir=…, apply=false)` — but the test should call the pure logic, not disk.
  Refactor the set-computation into an exported helper `findOrphans(store)` that
  the test calls directly (so no IO). Assert it returns exactly the orphan slugs,
  and leaves the referenced ones out.
- Assert that a work kept alive *only* by a cast role is NOT pruned.

## Done criteria

ALL must hold:

- [ ] `bun run prune` (dry-run) lists orphans and writes nothing
- [ ] `bun run prune --apply` removes them; `bun run validate` then exits 0
- [ ] `bun test packages/ingest` passes, including `findOrphans` cases
- [ ] `bun run typecheck` and `bun run lint` exit 0
- [ ] Apply step changed only global data files (and, if any, re-canonicalized
      per-house files — reported, not unexpected)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- Dry-run reports orders of magnitude more orphans than expected (~381 total) —
  the reference traversal is likely missing a field; do not `--apply`.
- After `--apply`, `bun run validate` reports any `dangling > 0` — the prune
  removed a referenced entity; revert the data change (`git checkout -- data`)
  and report.
- `store.save()` rewrites a large number of per-house production/performance files
  with substantive (non-formatting) changes — that implies `save` is doing more
  than re-canonicalizing; revert and report rather than committing a wide diff.

## Maintenance notes

- This is a manual hygiene tool, not part of the nightly pipeline — running it on
  every scrape would fight the intentional no-delete design and could churn the
  graph. Run it occasionally (after a big backfill or resolver change).
- When plan 006 fixes the Staatsoper Hamburg date-as-name bug, re-running prune
  will clear the now-orphaned junk persons (the cast references to them disappear
  when that house is re-scraped).
- A reviewer of the data commit should sanity-check the removed list for any
  recognizable real person/work that lost its last reference due to an unrelated bug.
