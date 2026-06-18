import { describe, expect, it } from "bun:test";
import { type HealthRecord, summarizeHealth } from "./index";

const makeRecord = (overrides: Partial<HealthRecord> & { slug: string }): HealthRecord => ({
  productions: 10,
  performances: 30,
  ok: true,
  ...overrides,
});

describe("summarizeHealth", () => {
  it("counts total, zeros, and errored correctly", () => {
    const records: HealthRecord[] = [
      makeRecord({ slug: "house-a", productions: 5, performances: 15 }),
      makeRecord({ slug: "house-b", productions: 0, performances: 0, ok: false }),
      makeRecord({ slug: "house-c", productions: 0, performances: 0, ok: false, error: "timeout" }),
    ];
    const summary = summarizeHealth(records);
    expect(summary.total).toBe(3);
    expect(summary.zeros).toBe(1);
    expect(summary.errored).toBe(1);
    expect(summary.lines).toHaveLength(3);
  });

  it("sorts ascending by production count — zeros first", () => {
    const records: HealthRecord[] = [
      makeRecord({ slug: "big", productions: 100, performances: 300 }),
      makeRecord({ slug: "zero", productions: 0, performances: 0, ok: false }),
      makeRecord({ slug: "small", productions: 5, performances: 10 }),
    ];
    const { lines } = summarizeHealth(records);
    expect(lines[0]).toContain("zero");
    expect(lines[1]).toContain("small");
    expect(lines[2]).toContain("big");
  });

  it("marks error records with ERROR status", () => {
    const records: HealthRecord[] = [
      makeRecord({ slug: "broken", productions: 0, performances: 0, ok: false, error: "503" }),
    ];
    const { lines } = summarizeHealth(records);
    expect(lines[0]).toContain("ERROR");
    expect(lines[0]).toContain("503");
  });

  it("marks zero-production records with ZERO status", () => {
    const records: HealthRecord[] = [
      makeRecord({ slug: "empty", productions: 0, performances: 0, ok: false }),
    ];
    const { lines } = summarizeHealth(records);
    expect(lines[0]).toContain("ZERO");
  });

  it("marks healthy records with ok status", () => {
    const records: HealthRecord[] = [
      makeRecord({ slug: "good", productions: 42, performances: 120, ok: true }),
    ];
    const { lines } = summarizeHealth(records);
    expect(lines[0]).toContain("ok");
    expect(lines[0]).toContain("good");
  });

  it("returns zeros=0 and errored=0 when all houses are healthy", () => {
    const records: HealthRecord[] = [
      makeRecord({ slug: "a", productions: 10, performances: 30 }),
      makeRecord({ slug: "b", productions: 20, performances: 60 }),
    ];
    const { zeros, errored } = summarizeHealth(records);
    expect(zeros).toBe(0);
    expect(errored).toBe(0);
  });

  it("handles empty input", () => {
    const { total, zeros, errored, lines } = summarizeHealth([]);
    expect(total).toBe(0);
    expect(zeros).toBe(0);
    expect(errored).toBe(0);
    expect(lines).toHaveLength(0);
  });
});
