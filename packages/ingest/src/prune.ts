import { CanonicalStore } from "./store";

export interface PruneReport {
  orphans: { persons: string[]; works: string[]; roles: string[] };
  counts: Record<string, number>;
}

export function findOrphans(store: CanonicalStore): {
  persons: string[];
  works: string[];
  roles: string[];
} {
  const refPersons = new Set<string>();
  const refRoles = new Set<string>();
  const refWorks = new Set<string>();

  const addCredits = (
    cast?: { person_slug?: string; role_slug?: string }[],
    crew?: { person_slug?: string }[],
  ) => {
    for (const c of cast ?? []) {
      if (c.person_slug) refPersons.add(c.person_slug);
      if (c.role_slug) refRoles.add(c.role_slug);
    }
    for (const c of crew ?? []) if (c.person_slug) refPersons.add(c.person_slug);
  };

  for (const p of store.productions.values()) {
    refWorks.add(p.work_slug);
    addCredits(p.cast, p.creative_team);
  }
  for (const f of store.performances.values()) addCredits(f.cast);
  for (const w of store.works.values()) if (w.composer_slug) refPersons.add(w.composer_slug);

  // A work is also referenced if any referenced role belongs to it
  for (const r of store.roles.values()) if (refRoles.has(r.slug)) refWorks.add(r.work_slug);

  return {
    persons: [...store.persons.keys()].filter((s) => !refPersons.has(s)).sort(),
    roles: [...store.roles.keys()].filter((s) => !refRoles.has(s)).sort(),
    works: [...store.works.keys()].filter((s) => !refWorks.has(s)).sort(),
  };
}

/**
 * Remove every zero-reference global entity, iterating to a fixpoint: pruning an
 * orphan work drops its `composer_slug` reference, which can orphan that composer,
 * and so on. Mutates the store in place; the caller decides whether to persist.
 * Returns the cumulative removed set (sorted) across all rounds.
 */
export function pruneStore(store: CanonicalStore): {
  persons: string[];
  works: string[];
  roles: string[];
} {
  const removed = {
    persons: new Set<string>(),
    works: new Set<string>(),
    roles: new Set<string>(),
  };
  let round = findOrphans(store);
  while (round.persons.length + round.works.length + round.roles.length > 0) {
    for (const s of round.persons) {
      store.persons.delete(s);
      removed.persons.add(s);
    }
    for (const s of round.roles) {
      store.roles.delete(s);
      removed.roles.add(s);
    }
    for (const s of round.works) {
      store.works.delete(s);
      removed.works.add(s);
    }
    round = findOrphans(store);
  }
  return {
    persons: [...removed.persons].sort(),
    works: [...removed.works].sort(),
    roles: [...removed.roles].sort(),
  };
}

export async function prune(dir: string, apply: boolean): Promise<PruneReport> {
  const store = await CanonicalStore.load(dir);
  // pruneStore mutates the in-memory store to a fixpoint; in dry-run we just don't save it.
  const orphans = pruneStore(store);
  if (apply) await store.save(dir);
  return {
    orphans,
    counts: {
      orphan_persons: orphans.persons.length,
      orphan_roles: orphans.roles.length,
      orphan_works: orphans.works.length,
    },
  };
}
