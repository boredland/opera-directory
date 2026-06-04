import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
 * git-diff-reviewable JSON under data/. A derived SQLite/D1 read-copy comes
 * later, only when the performances table outgrows a loadable array.
 *
 * Layout reflects the two kinds of entity:
 *   - Cross-house graph (works / persons / roles) — one global file each. These
 *     are shared by design: one Work "Aida" is staged at many houses, so they
 *     must NOT be split per house or the dedup graph breaks.
 *   - House-scoped (productions / performances) — one file per house under
 *     data/productions/{house}.json and data/performances/{house}.json, so a
 *     re-scrape of one house produces a small, reviewable diff instead of
 *     churning a monolith.
 *
 * Everything is keyed by stable id so the pipeline is idempotent: re-running a
 * scrape upserts and converges, never duplicates. Upsert is insert-or-merge and
 * NEVER deletes — a performance that rolls out of the live window survives from
 * the run that first saw it, which is exactly how history accumulates.
 */

/** Global files for the cross-house graph. */
const SHARED_FILES = {
  works: "works.json",
  persons: "persons.json",
  roles: "roles.json",
} as const;
/** Per-house directories for house-scoped entities (one {house}.json each). */
const PRODUCTIONS_DIR = "productions";
const PERFORMANCES_DIR = "performances";

/** Productions/performances ids are `${house}/…`, so the house is the first segment. */
function houseOf(id: string): string {
  return id.split("/")[0] ?? "unknown";
}

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
      readArray<Work>(join(dir, SHARED_FILES.works)),
      readArray<Person>(join(dir, SHARED_FILES.persons)),
      readArray<Role>(join(dir, SHARED_FILES.roles)),
      readDir<Production>(join(dir, PRODUCTIONS_DIR)),
      readDir<Performance>(join(dir, PERFORMANCES_DIR)),
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
        join(dir, SHARED_FILES.works),
        sortBy([...this.works.values()], (w) => w.slug),
      ),
      writeArray(
        join(dir, SHARED_FILES.persons),
        sortBy([...this.persons.values()], (p) => p.slug),
      ),
      writeArray(
        join(dir, SHARED_FILES.roles),
        sortBy([...this.roles.values()], (r) => r.slug),
      ),
      writePerHouse(
        join(dir, PRODUCTIONS_DIR),
        [...this.productions.values()],
        (p) => p.house_slug,
      ),
      writePerHouse(join(dir, PERFORMANCES_DIR), [...this.performances.values()], (p) =>
        houseOf(p.production_id),
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

/** Read every `*.json` in a directory (sorted) and concatenate. Empty if absent. */
async function readDir<T>(dir: string): Promise<T[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: T[] = [];
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    out.push(...(await readArray<T>(join(dir, file))));
  }
  return out;
}

async function writeArray<T>(path: string, items: T[]): Promise<void> {
  await writeFile(path, `${JSON.stringify(items.map(clean), null, 2)}\n`);
}

/** Group items by house and write one sorted `{house}.json` per house. */
async function writePerHouse<T extends { id: string }>(
  dir: string,
  items: T[],
  houseOfItem: (item: T) => string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const byHouse = new Map<string, T[]>();
  for (const item of items) {
    const house = houseOfItem(item);
    let list = byHouse.get(house);
    if (!list) {
      list = [];
      byHouse.set(house, list);
    }
    list.push(item);
  }
  await Promise.all(
    [...byHouse].map(([house, list]) =>
      writeArray(
        join(dir, `${house}.json`),
        sortBy(list, (i) => i.id),
      ),
    ),
  );
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
