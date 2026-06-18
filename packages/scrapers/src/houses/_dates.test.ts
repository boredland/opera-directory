import { describe, expect, test } from "bun:test";
import { isoFromParts, parseGermanDotDate } from "./_dates";

describe("isoFromParts", () => {
  test("assembles a valid ISO date from numeric parts", () => {
    expect(isoFromParts(2026, 6, 18)).toBe("2026-06-18");
  });

  test("zero-pads single-digit month and day", () => {
    expect(isoFromParts(2026, 1, 3)).toBe("2026-01-03");
  });

  test("accepts string parts", () => {
    expect(isoFromParts("2026", "06", "18")).toBe("2026-06-18");
  });

  test("expands a 2-digit year to 20xx", () => {
    expect(isoFromParts("26", "06", "18")).toBe("2026-06-18");
  });

  test("expands 2-digit year 00 to 2000", () => {
    expect(isoFromParts("00", "1", "1")).toBe("2000-01-01");
  });

  test("returns null for non-numeric year", () => {
    expect(isoFromParts("abc", "06", "18")).toBeNull();
  });

  test("returns null for non-numeric month", () => {
    expect(isoFromParts(2026, "xx", "18")).toBeNull();
  });

  test("returns null for non-numeric day", () => {
    expect(isoFromParts(2026, 6, "")).toBeNull();
  });

  test("handles full 4-digit year string without expansion", () => {
    expect(isoFromParts("2030", "12", "31")).toBe("2030-12-31");
  });
});

describe("parseGermanDotDate", () => {
  test("parses dd.mm.yy (2-digit year)", () => {
    expect(parseGermanDotDate("18.06.26")).toBe("2026-06-18");
  });

  test("parses dd.mm.yyyy (4-digit year)", () => {
    expect(parseGermanDotDate("18.06.2026")).toBe("2026-06-18");
  });

  test("parses with surrounding context text", () => {
    expect(parseGermanDotDate("Samstag 6.6.26 19:00 Uhr")).toBe("2026-06-06");
  });

  test("zero-pads single-digit day and month", () => {
    expect(parseGermanDotDate("3.1.2026")).toBe("2026-01-03");
  });

  test("returns null for empty string", () => {
    expect(parseGermanDotDate("")).toBeNull();
  });

  test("returns null for non-matching text", () => {
    expect(parseGermanDotDate("no date here")).toBeNull();
  });

  test("returns null for partial date (no year)", () => {
    expect(parseGermanDotDate("18.06")).toBeNull();
  });
});
