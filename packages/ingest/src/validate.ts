/**
 * Referential-integrity validator for the committed JSON graph under `data/`.
 *
 * Checks every slug / id cross-reference between productions, performances,
 * roles, works, persons, and houses and collects dangling references as hard
 * errors.  Data-sanity smells (e.g. dates minted as person names) are
 * collected as warnings — they surface in the report but do not fail the build.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CanonicalStore } from "./store";

export interface ValidationReport {
  errors: string[]; // dangling references — must be empty for a valid graph
  warnings: string[]; // data-sanity smells — reported, do not fail the build (yet)
  counts: Record<string, number>;
}

/** A person name that is actually a date ("1.1.27", "13.12.26 /") — a scraper bug. */
const DATE_LIKE_NAME = /^\s*\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b/;

export async function validateData(dir: string): Promise<ValidationReport> {
  const store = await CanonicalStore.load(dir);
  const houses = new Set<string>(
    (JSON.parse(await readFile(join(dir, "houses.json"), "utf8")) as { slug: string }[]).map(
      (h) => h.slug,
    ),
  );
  const errors: string[] = [];
  const warnings: string[] = [];

  const checkPerson = (slug: string | undefined, where: string) => {
    if (slug && !store.persons.has(slug))
      errors.push(`${where}: person_slug "${slug}" not in persons.json`);
  };
  const checkRole = (slug: string | undefined, where: string) => {
    if (slug && !store.roles.has(slug))
      errors.push(`${where}: role_slug "${slug}" not in roles.json`);
  };

  for (const p of store.productions.values()) {
    if (!store.works.has(p.work_slug))
      errors.push(`production ${p.id}: work_slug "${p.work_slug}" not in works.json`);
    if (!houses.has(p.house_slug))
      errors.push(`production ${p.id}: house_slug "${p.house_slug}" not in houses.json`);
    for (const c of p.creative_team ?? [])
      checkPerson(c.person_slug, `production ${p.id} creative`);
    for (const c of p.cast ?? []) {
      checkPerson(c.person_slug, `production ${p.id} cast`);
      checkRole(c.role_slug, `production ${p.id} cast`);
    }
  }
  for (const f of store.performances.values()) {
    if (!store.productions.has(f.production_id))
      errors.push(`performance ${f.id}: production_id "${f.production_id}" not in productions`);
    for (const c of f.cast ?? []) {
      checkPerson(c.person_slug, `performance ${f.id} cast`);
      checkRole(c.role_slug, `performance ${f.id} cast`);
    }
  }
  for (const r of store.roles.values()) {
    if (!store.works.has(r.work_slug))
      errors.push(`role ${r.slug}: work_slug "${r.work_slug}" not in works.json`);
  }
  for (const w of store.works.values()) {
    if (w.composer_slug && !store.persons.has(w.composer_slug))
      errors.push(`work ${w.slug}: composer_slug "${w.composer_slug}" not in persons.json`);
  }

  // Sanity (warnings only): dates minted as people, empty names.
  for (const person of store.persons.values()) {
    if (DATE_LIKE_NAME.test(person.name))
      warnings.push(
        `person "${person.slug}" has a date-like name "${person.name}" (likely a scraper bug)`,
      );
    if (!person.name.trim()) warnings.push(`person "${person.slug}" has an empty name`);
  }

  return {
    errors,
    warnings,
    counts: {
      ...store.counts(),
      houses: houses.size,
      dangling: errors.length,
      sanity: warnings.length,
    },
  };
}
