import { describe, expect, test } from "bun:test";
import type { RawProduction } from "@opera-directory/scrapers";
import { ingestRawProduction } from "./resolve";
import { CanonicalStore } from "./store";

// ── CanonicalStore constructibility ─────────────────────────────────────────

test("CanonicalStore is constructible with new", () => {
  const store = new CanonicalStore();
  expect(store).toBeInstanceOf(CanonicalStore);
  expect(store.counts()).toEqual({
    works: 0,
    persons: 0,
    roles: 0,
    productions: 0,
    performances: 0,
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

const idempotencyFixture: RawProduction = {
  source_production_id: "figaro-2025",
  work_title: "Le nozze di Figaro",
  composer_name: "Wolfgang Amadeus Mozart",
  premiere_season: "2025/26",
  premiere_date: "2025-10-01",
  is_revival: false,
  creative_team: [
    { function: "conductor", name: "Karl Böhm" },
    { function: "director", name: "Peter Sellars" },
  ],
  cast: [
    { role: "Figaro", name: "Bryn Terfel" },
    { role: "Susanna", name: "Anna Netrebko" },
  ],
  performances: [
    { date: "2025-10-01", time: "19:30" },
    { date: "2025-10-05", time: "15:00" },
  ],
};

describe("idempotency", () => {
  test("ingesting the same fixture twice produces identical counts (no duplicates)", () => {
    const store = new CanonicalStore();
    ingestRawProduction(store, idempotencyFixture, "opera-house");
    const afterFirst = { ...store.counts() };

    ingestRawProduction(store, idempotencyFixture, "opera-house");
    const afterSecond = store.counts();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("same slugs and ids exist after both runs (no new entries minted)", () => {
    const store = new CanonicalStore();
    ingestRawProduction(store, idempotencyFixture, "opera-house");
    const workSlugs = [...store.works.keys()];
    const prodIds = [...store.productions.keys()];
    const perfIds = [...store.performances.keys()];

    ingestRawProduction(store, idempotencyFixture, "opera-house");

    expect([...store.works.keys()].sort()).toEqual(workSlugs.sort());
    expect([...store.productions.keys()].sort()).toEqual(prodIds.sort());
    expect([...store.performances.keys()].sort()).toEqual(perfIds.sort());
  });
});

// ── mergeFill first-write-wins ────────────────────────────────────────────────

describe("upsertWork — first-write-wins for set fields, fills nulls", () => {
  test("title stays as first write even when a second write has a different title", () => {
    const store = new CanonicalStore();
    store.upsertWork({ slug: "some-work", title: "A", composer_slug: "c", wikidata: null });
    store.upsertWork({ slug: "some-work", title: "B", composer_slug: "c", wikidata: "Q1" });
    const work = store.works.get("some-work");
    expect(work).toBeDefined();
    expect(work?.title).toBe("A");
  });

  test("null wikidata field gets filled on second upsert", () => {
    const store = new CanonicalStore();
    store.upsertWork({ slug: "some-work", title: "A", composer_slug: "c", wikidata: null });
    store.upsertWork({ slug: "some-work", title: "B", composer_slug: "c", wikidata: "Q1" });
    const work = store.works.get("some-work");
    expect(work).toBeDefined();
    expect(work?.wikidata).toBe("Q1");
  });
});

// ── professions union ─────────────────────────────────────────────────────────

describe("upsertPerson — professions union", () => {
  test("two upserts with different professions yield sorted union", () => {
    const store = new CanonicalStore();
    store.upsertPerson({ slug: "john-doe", name: "John Doe", professions: ["composer"] });
    store.upsertPerson({ slug: "john-doe", name: "John Doe", professions: ["conductor"] });
    const person = store.persons.get("john-doe");
    expect(person).toBeDefined();
    expect(person?.professions).toEqual(["composer", "conductor"]);
  });

  test("duplicate professions are deduplicated", () => {
    const store = new CanonicalStore();
    store.upsertPerson({ slug: "jane-doe", name: "Jane Doe", professions: ["singer"] });
    store.upsertPerson({ slug: "jane-doe", name: "Jane Doe", professions: ["singer"] });
    const person = store.persons.get("jane-doe");
    expect(person).toBeDefined();
    expect(person?.professions).toEqual(["singer"]);
  });
});

// ── performance merge ─────────────────────────────────────────────────────────

describe("upsertPerformance — merge semantics", () => {
  test("null field gets filled on second upsert", () => {
    const store = new CanonicalStore();
    store.upsertPerformance({
      id: "house/work/season/2025-10-01/19:30",
      production_id: "house/work/season",
      date: "2025-10-01",
      time: "19:30",
      venue_room: null,
      ticket_url: null,
    });
    store.upsertPerformance({
      id: "house/work/season/2025-10-01/19:30",
      production_id: "house/work/season",
      date: "2025-10-01",
      time: "19:30",
      venue_room: "Main Stage",
      ticket_url: "https://tickets.example.com/1",
    });
    const perf = store.performances.get("house/work/season/2025-10-01/19:30");
    expect(perf).toBeDefined();
    expect(perf?.venue_room).toBe("Main Stage");
    expect(perf?.ticket_url).toBe("https://tickets.example.com/1");
  });

  test("already-set field is not overwritten on second upsert", () => {
    const store = new CanonicalStore();
    store.upsertPerformance({
      id: "house/work/season/2025-10-02/20:00",
      production_id: "house/work/season",
      date: "2025-10-02",
      time: "20:00",
      venue_room: "Grand Hall",
      ticket_url: null,
    });
    store.upsertPerformance({
      id: "house/work/season/2025-10-02/20:00",
      production_id: "house/work/season",
      date: "2025-10-02",
      time: "20:00",
      venue_room: "Small Stage",
      ticket_url: null,
    });
    const perf = store.performances.get("house/work/season/2025-10-02/20:00");
    expect(perf).toBeDefined();
    expect(perf?.venue_room).toBe("Grand Hall");
  });
});
