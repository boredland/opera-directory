import type { Person, QID, Slug, Work } from "@opera-directory/schema";

/**
 * Entity resolution — the make-or-break pass.
 *
 * Scrapers emit free-text names ("Wolfgang Amadeus Mozart", "Le nozze di Figaro").
 * To build a navigable dataset like operabook.org — where you click a work and
 * see every production worldwide — those strings must collapse onto stable
 * canonical entities. We resolve in tiers, cheapest/most-reliable first, and
 * NEVER auto-merge below a confidence threshold (ambiguous matches go to a
 * review queue, mirroring the museumsufer audit-allowlist pattern).
 *
 * Tier 1 — Wikidata (CC0): the canonical registry. Composers, conductors,
 *   directors, singers, and most repertory works have QIDs. Resolve via the
 *   wbsearchentities API constrained by P106 (occupation) / P31 (instance of
 *   opera Q1344), cache aggressively. A QID match is authoritative.
 * Tier 2 — MusicBrainz: fills work/recording gaps Wikidata misses, and gives
 *   stable artist MBIDs for cross-linking.
 * Tier 3 — internal fuzzy match against already-resolved entities (normalized
 *   name + composer for works; normalized name + birth year for persons).
 * Tier 4 — mint a provisional slug and flag for review. Provisional entities
 *   are still served, but a later run can fold them into a QID match.
 */

export interface ResolveCaches {
  worksByKey: Map<string, Work>;
  personsByKey: Map<string, Person>;
  /** name → QID memo so we don't hammer the Wikidata API across a run. */
  wikidataMemo: Map<string, QID | null>;
}

export interface ResolveOutcome<T> {
  entity: T;
  confidence: number;
  /** true → needs human review before it's trusted for merging. */
  provisional: boolean;
}

export function slugify(input: string): Slug {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalized key for fuzzy work matching: composer + title, accent/diacritic folded. */
export function workKey(title: string, composerName: string | null | undefined): string {
  return `${slugify(composerName ?? "")}::${slugify(title)}`;
}

// TODO(implementer): implement the tiers. Suggested signatures:
//
//   resolvePerson(name: string, hints: { profession?: string }, caches): Promise<ResolveOutcome<Person>>
//   resolveWork(title: string, composerName: string | null, caches): Promise<ResolveOutcome<Work>>
//
// Start with Tier 3 (internal fuzzy) + Tier 4 (mint provisional) so the pipeline
// runs end-to-end offline, then layer in Wikidata (Tier 1) for accuracy.
