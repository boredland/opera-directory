import { describe, expect, it } from "bun:test";
import type { Performance, Person, Production, Role, Work } from "@opera-directory/schema";
import { findOrphans, pruneStore } from "./prune";
import { CanonicalStore } from "./store";

function makeStore(opts: {
  works?: Work[];
  persons?: Person[];
  roles?: Role[];
  productions?: Production[];
  performances?: Performance[];
}): CanonicalStore {
  const store = new CanonicalStore();
  for (const w of opts.works ?? []) store.upsertWork(w);
  for (const p of opts.persons ?? []) store.upsertPerson(p);
  for (const r of opts.roles ?? []) store.upsertRole(r);
  for (const p of opts.productions ?? []) store.upsertProduction(p);
  for (const f of opts.performances ?? []) store.upsertPerformance(f);
  return store;
}

const baseWork = (slug: string, composerSlug: string): Work => ({
  slug,
  title: slug,
  composer_slug: composerSlug,
});

const basePerson = (slug: string): Person => ({ slug, name: slug });

const baseRole = (slug: string, workSlug: string): Role => ({
  slug,
  work_slug: workSlug,
  name: slug,
});

const baseProduction = (id: string, workSlug: string, houseSlug = "test-house"): Production => ({
  id,
  work_slug: workSlug,
  house_slug: houseSlug,
  creative_team: [],
  cast: [],
});

describe("findOrphans", () => {
  it("returns empty when everything is referenced", () => {
    const composer = basePerson("composer-a");
    const work = baseWork("work-a", "composer-a");
    const role = baseRole("role-a", "work-a");
    const singer = basePerson("singer-a");
    const prod = {
      ...baseProduction("test-house/work-a/2024", "work-a"),
      cast: [{ person_slug: "singer-a", role_slug: "role-a" }],
    };
    const store = makeStore({
      works: [work],
      persons: [composer, singer],
      roles: [role],
      productions: [prod],
    });
    const orphans = findOrphans(store);
    expect(orphans.works).toEqual([]);
    expect(orphans.persons).toEqual([]);
    expect(orphans.roles).toEqual([]);
  });

  it("identifies orphan work, person, and role with no references", () => {
    const orphanWork = baseWork("orphan-work", "orphan-composer");
    const orphanPerson = basePerson("orphan-person");
    const orphanRole = baseRole("orphan-role", "orphan-work");
    const store = makeStore({
      works: [orphanWork],
      persons: [orphanPerson],
      roles: [orphanRole],
    });
    const orphans = findOrphans(store);
    expect(orphans.works).toContain("orphan-work");
    expect(orphans.persons).toContain("orphan-person");
    expect(orphans.roles).toContain("orphan-role");
  });

  it("a work kept alive only by a referenced cast role is NOT pruned", () => {
    const composer = basePerson("composer-b");
    const work = baseWork("work-b", "composer-b");
    const role = baseRole("role-b", "work-b");
    // The production references a DIFFERENT work, but the role belongs to work-b
    const anotherWork = baseWork("work-c", "composer-b");
    const prod = {
      ...baseProduction("test-house/work-c/2024", "work-c"),
      cast: [{ person_slug: "composer-b", role_slug: "role-b" }],
    };
    const store = makeStore({
      works: [work, anotherWork],
      persons: [composer],
      roles: [role],
      productions: [prod],
    });
    const orphans = findOrphans(store);
    // role-b is referenced by the production cast, so work-b (its parent) must be kept
    expect(orphans.roles).not.toContain("role-b");
    expect(orphans.works).not.toContain("work-b");
    // work-c is referenced directly
    expect(orphans.works).not.toContain("work-c");
  });

  it("keeps composer referenced via Work.composer_slug", () => {
    const composer = basePerson("composer-c");
    const work = baseWork("work-d", "composer-c");
    const prod = baseProduction("test-house/work-d/2024", "work-d");
    const store = makeStore({
      works: [work],
      persons: [composer],
      productions: [prod],
    });
    const orphans = findOrphans(store);
    expect(orphans.persons).not.toContain("composer-c");
  });

  it("keeps person referenced only in creative_team", () => {
    const director = basePerson("director-a");
    const composer = basePerson("composer-d");
    const work = baseWork("work-e", "composer-d");
    const prod = {
      ...baseProduction("test-house/work-e/2024", "work-e"),
      creative_team: [{ person_slug: "director-a", function: "director" }],
    };
    const store = makeStore({
      works: [work],
      persons: [director, composer],
      productions: [prod],
    });
    const orphans = findOrphans(store);
    expect(orphans.persons).not.toContain("director-a");
  });

  it("keeps person referenced only in Performance.cast", () => {
    const singer = basePerson("singer-b");
    const composer = basePerson("composer-e");
    const work = baseWork("work-f", "composer-e");
    const role = baseRole("role-c", "work-f");
    const prod = baseProduction("test-house/work-f/2024", "work-f");
    const perf: Performance = {
      id: "test-house/work-f/2024/2025-01-01/20:00",
      production_id: "test-house/work-f/2024",
      date: "2025-01-01",
      cast: [{ person_slug: "singer-b", role_slug: "role-c" }],
    };
    const store = makeStore({
      works: [work],
      persons: [singer, composer],
      roles: [role],
      productions: [prod],
      performances: [perf],
    });
    const orphans = findOrphans(store);
    expect(orphans.persons).not.toContain("singer-b");
    expect(orphans.roles).not.toContain("role-c");
  });

  it("returns sorted lists", () => {
    const store = makeStore({
      persons: [basePerson("z-person"), basePerson("a-person")],
    });
    const orphans = findOrphans(store);
    expect(orphans.persons).toEqual(["a-person", "z-person"]);
  });

  it("mixes referenced and orphan entities correctly", () => {
    const composer = basePerson("composer-f");
    const orphanPerson = basePerson("orphan-p");
    const refWork = baseWork("ref-work", "composer-f");
    const orphanWork = baseWork("orphan-w", "composer-f");
    const refRole = baseRole("ref-role", "ref-work");
    const orphanRole = baseRole("orphan-r", "ref-work");
    const prod = {
      ...baseProduction("test-house/ref-work/2024", "ref-work"),
      cast: [{ person_slug: "composer-f", role_slug: "ref-role" }],
    };
    const store = makeStore({
      works: [refWork, orphanWork],
      persons: [composer, orphanPerson],
      roles: [refRole, orphanRole],
      productions: [prod],
    });
    const orphans = findOrphans(store);
    expect(orphans.works).toEqual(["orphan-w"]);
    expect(orphans.persons).toEqual(["orphan-p"]);
    expect(orphans.roles).toEqual(["orphan-r"]);
  });
});

describe("pruneStore (fixpoint)", () => {
  it("removes a composer orphaned only by pruning its orphan work (transitive cascade)", () => {
    // work-x is referenced by nothing; composer-x is referenced ONLY by work-x.
    // A single findOrphans pass sees work-x as orphan but composer-x as referenced.
    // pruneStore must iterate: remove work-x → composer-x becomes orphan → remove it.
    const store = makeStore({
      works: [baseWork("work-x", "composer-x")],
      persons: [basePerson("composer-x")],
    });
    // One pass keeps the composer:
    expect(findOrphans(store).persons).not.toContain("composer-x");

    const removed = pruneStore(store);
    expect(removed.works).toEqual(["work-x"]);
    expect(removed.persons).toEqual(["composer-x"]);
    // Store is now at a fixpoint — nothing left to prune.
    const after = findOrphans(store);
    expect(after.works.length + after.persons.length + after.roles.length).toBe(0);
  });

  it("leaves a fully-referenced store untouched", () => {
    const store = makeStore({
      works: [baseWork("work-y", "composer-y")],
      persons: [basePerson("composer-y")],
      productions: [baseProduction("test-house/work-y/2024", "work-y")],
    });
    const removed = pruneStore(store);
    expect(removed.works).toEqual([]);
    expect(removed.persons).toEqual([]);
    expect(removed.roles).toEqual([]);
  });
});
