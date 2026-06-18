import { describe, expect, test } from "bun:test";
import type { RawProduction } from "@opera-directory/scrapers";
import { ingestRawProduction, slugify, workKey } from "./resolve";
import { CanonicalStore } from "./store";

// ── slugify ──────────────────────────────────────────────────────────────────

describe("slugify", () => {
  test("lowercases and joins words with hyphens", () => {
    expect(slugify("Wolfgang Amadeus Mozart")).toBe("wolfgang-amadeus-mozart");
  });

  test("folds accents / diacritics", () => {
    expect(slugify("Léo Delibes")).toBe("leo-delibes");
  });

  test("trims leading and trailing punctuation", () => {
    expect(slugify("--hello--")).toBe("hello");
    expect(slugify("!foo!")).toBe("foo");
  });

  test("empty string produces empty slug", () => {
    expect(slugify("")).toBe("");
  });

  test("punctuation-only string produces empty slug", () => {
    expect(slugify("---")).toBe("");
  });

  test("collapses multiple consecutive non-alphanumeric chars to a single hyphen", () => {
    expect(slugify("a  b")).toBe("a-b");
  });
});

// ── workKey ──────────────────────────────────────────────────────────────────

describe("workKey", () => {
  test("returns composer::title both slugified", () => {
    const key = workKey("Le nozze di Figaro", "W. A. Mozart");
    expect(key).toBe(`${slugify("W. A. Mozart")}::${slugify("Le nozze di Figaro")}`);
    expect(key).toBe("w-a-mozart::le-nozze-di-figaro");
  });

  test("null composer yields a leading '::'", () => {
    const key = workKey("Carmen", null);
    expect(key).toStartWith("::");
    expect(key).toBe("::carmen");
  });

  test("undefined composer also yields leading '::'", () => {
    expect(workKey("Aida", undefined)).toBe("::aida");
  });
});

// ── ingestRawProduction ──────────────────────────────────────────────────────

/** Minimal valid fixture for a production with a composer, cast, creative team, and 2 performances. */
function makeFixture(): RawProduction {
  return {
    source_production_id: "prod-42",
    work_title: "Le nozze di Figaro",
    composer_name: "Wolfgang Amadeus Mozart",
    premiere_season: "2025/26",
    premiere_date: "2025-10-01",
    is_revival: false,
    creative_team: [
      { function: "conductor", name: "Karl Böhm" },
      { function: null, name: "Unknown Function Person" }, // should be dropped
    ],
    cast: [
      { role: "Figaro", name: "Bryn Terfel" },
      { role: "Susanna", name: "Anna Netrebko" },
      { role: null, name: "No Role Person" }, // should be dropped
    ],
    performances: [
      { date: "2025-10-01", time: "19:30" },
      { date: "2025-10-05", time: "15:00" },
    ],
  };
}

describe("ingestRawProduction", () => {
  test("mints correct work slug: composer-slug/title-slug", () => {
    const store = new CanonicalStore();
    ingestRawProduction(store, makeFixture(), "test-house");
    // Mozart's slug is "wolfgang-amadeus-mozart"; title slug is "le-nozze-di-figaro"
    expect(store.works.has("wolfgang-amadeus-mozart/le-nozze-di-figaro")).toBeTrue();
  });

  test("mints correct production id: house/title-slug/season-slug when premiere_season is set", () => {
    const store = new CanonicalStore();
    ingestRawProduction(store, makeFixture(), "test-house");
    // premiere_season "2025/26" → slugify → "2025-26"
    expect(store.productions.has("test-house/le-nozze-di-figaro/2025-26")).toBeTrue();
  });

  test("mints correct performance ids: productionId/date/time", () => {
    const store = new CanonicalStore();
    ingestRawProduction(store, makeFixture(), "test-house");
    expect(
      store.performances.has("test-house/le-nozze-di-figaro/2025-26/2025-10-01/19:30"),
    ).toBeTrue();
    expect(
      store.performances.has("test-house/le-nozze-di-figaro/2025-26/2025-10-05/15:00"),
    ).toBeTrue();
  });

  test("drops cast credit with null role", () => {
    const store = new CanonicalStore();
    ingestRawProduction(store, makeFixture(), "test-house");
    const prod = store.productions.get("test-house/le-nozze-di-figaro/2025-26");
    expect(prod).toBeDefined();
    // Only Figaro and Susanna should be in cast; "No Role Person" dropped
    const personSlugs = prod?.cast.map((c) => c.person_slug) ?? [];
    expect(personSlugs).not.toContain("no-role-person");
    expect(prod?.cast).toHaveLength(2);
  });

  test("drops creative credit with null function", () => {
    const store = new CanonicalStore();
    ingestRawProduction(store, makeFixture(), "test-house");
    const prod = store.productions.get("test-house/le-nozze-di-figaro/2025-26");
    expect(prod).toBeDefined();
    // Only Karl Böhm (conductor) is kept; "Unknown Function Person" is dropped
    expect(prod?.creative_team).toHaveLength(1);
    expect(prod?.creative_team[0]?.function).toBe("conductor");
  });

  test("uses house/source-id-slug for production id when premiere_season is absent", () => {
    const store = new CanonicalStore();
    const raw: RawProduction = {
      source_production_id: "my-source-id",
      work_title: "Carmen",
      composer_name: "Georges Bizet",
      premiere_season: null,
      performances: [],
    };
    ingestRawProduction(store, raw, "test-house");
    expect(store.productions.has("test-house/my-source-id")).toBeTrue();
  });
});
