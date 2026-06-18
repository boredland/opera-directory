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

export async function prune(dir: string, apply: boolean): Promise<PruneReport> {
  const store = await CanonicalStore.load(dir);
  const orphans = findOrphans(store);
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
