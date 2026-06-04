import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Performance,
  Person,
  Production,
  QID,
  Role,
  Slug,
  Work,
} from "@opera-directory/schema";
import { workKey } from "./resolve";

/**
 * The canonical store. Per README §6 the source of truth is committed,
 * git-diff-reviewable JSON under data/ — one normalized file per entity. A
 * derived SQLite/D1 read-copy comes later, only when the performances table
 * outgrows a loadable array; this layer stays JSON.
 *
 * Everything is keyed by stable id so the pipeline is idempotent: re-running a
 * scrape upserts and converges, never duplicates. Upsert is insert-or-merge and
 * NEVER deletes — a performance that rolls out of the live window survives from
 * the run that first saw it, which is exactly how history accumulates.
 */

const FILES = {
  works: "works.json",
  persons: "persons.json",
  roles: "roles.json",
  productions: "productions.json",
  performances: "performances.json",
} as const;

export class CanonicalStore {
  readonly works = new Map<Slug, Work>();
  readonly persons = new Map<Slug, Person>();
  readonly roles = new Map<Slug, Role>();
  readonly productions = new Map<string, Production>();
  readonly performances = new Map<string, Performance>();

  /** Resolution indices: a work is dedup-keyed on its QID, else composer+title. */
  readonly worksByQid = new Map<QID, Slug>();
  readonly worksByKey = new Map<string, Slug>();

  static async load(dir: string): Promise<CanonicalStore> {
    const store = new CanonicalStore();
    const [works, persons, roles, productions, performances] = await Promise.all([
      readArray<Work>(join(dir, FILES.works)),
      readArray<Person>(join(dir, FILES.persons)),
      readArray<Role>(join(dir, FILES.roles)),
      readArray<Production>(join(dir, FILES.productions)),
      readArray<Performance>(join(dir, FILES.performances)),
    ]);
    for (const w of works) store.indexWork(w);
    for (const p of persons) store.persons.set(p.slug, p);
    for (const r of roles) store.roles.set(r.slug, r);
    for (const p of productions) store.productions.set(p.id, p);
    for (const p of performances) store.performances.set(p.id, p);
    return store;
  }

  private indexWork(w: Work): void {
    this.works.set(w.slug, w);
    if (w.wikidata) this.worksByQid.set(w.wikidata, w.slug);
    this.worksByKey.set(workKey(w.title, slugToComposer(w)), w.slug);
  }

  upsertWork(work: Work): Work {
    const existing = this.works.get(work.slug);
    const merged = existing ? mergeFill(existing, work) : work;
    this.indexWork(merged);
    return merged;
  }

  upsertPerson(person: Person): Person {
    const existing = this.persons.get(person.slug);
    const merged = existing ? mergeFill(existing, person) : person;
    if (existing) merged.professions = unionList(existing.professions, person.professions);
    this.persons.set(merged.slug, merged);
    return merged;
  }

  upsertRole(role: Role): Role {
    const merged = this.roles.get(role.slug) ?? role;
    this.roles.set(merged.slug, mergeFill(merged, role));
    return this.roles.get(merged.slug) as Role;
  }

  /** Productions are fully recomputed from their authoritative source each run. */
  upsertProduction(production: Production): void {
    this.productions.set(production.id, production);
  }

  upsertPerformance(perf: Performance): void {
    const existing = this.performances.get(perf.id);
    this.performances.set(perf.id, existing ? mergeFill(existing, perf) : perf);
  }

  async save(dir: string): Promise<void> {
    await Promise.all([
      writeArray(
        join(dir, FILES.works),
        sortBy([...this.works.values()], (w) => w.slug),
      ),
      writeArray(
        join(dir, FILES.persons),
        sortBy([...this.persons.values()], (p) => p.slug),
      ),
      writeArray(
        join(dir, FILES.roles),
        sortBy([...this.roles.values()], (r) => r.slug),
      ),
      writeArray(
        join(dir, FILES.productions),
        sortBy([...this.productions.values()], (p) => p.id),
      ),
      writeArray(
        join(dir, FILES.performances),
        sortBy([...this.performances.values()], (p) => p.id),
      ),
    ]);
  }

  counts(): Record<string, number> {
    return {
      works: this.works.size,
      persons: this.persons.size,
      roles: this.roles.size,
      productions: this.productions.size,
      performances: this.performances.size,
    };
  }
}

/** Reconstruct the composer name component a work was keyed on, for re-indexing. */
function slugToComposer(_w: Work): string {
  // worksByKey folds composer + title; on reload we only have composer_slug, which
  // is already the slugified composer name — workKey re-slugifies, so pass it through.
  return _w.composer_slug;
}

// ── merge / sort / io helpers ───────────────────────────────────────────────

/** Fill null/undefined fields of `base` from `next`; keep already-set values. */
function mergeFill<T extends object>(base: T, next: T): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(next)) {
    const cur = out[k];
    if (cur === null || cur === undefined || cur === "") out[k] = v;
  }
  return out as T;
}

function unionList(a?: string[], b?: string[]): string[] | undefined {
  const set = new Set([...(a ?? []), ...(b ?? [])]);
  return set.size ? [...set].sort() : undefined;
}

function sortBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}

async function readArray<T>(path: string): Promise<T[]> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeArray<T>(path: string, items: T[]): Promise<void> {
  await writeFile(path, `${JSON.stringify(items.map(clean), null, 2)}\n`);
}

/** Drop null/undefined scalars so files stay lean; keep arrays and `false`. */
function clean<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map(clean) as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      out[k] = typeof v === "object" ? clean(v) : v;
    }
    return out as T;
  }
  return obj;
}
