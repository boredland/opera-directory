import type {
  CastCredit,
  CreativeCredit,
  Performance,
  Person,
  Production,
  Role,
  Slug,
  Work,
} from "@opera-directory/schema";
import type { RawProduction } from "@opera-directory/scrapers";
import type { CanonicalStore } from "./store";

/**
 * Entity resolution — the make-or-break pass.
 *
 * Scrapers emit free-text names ("Wolfgang Amadeus Mozart", "Le nozze di Figaro").
 * To build a navigable dataset like operabook.org — where you click a work and
 * see every production worldwide — those strings must collapse onto stable
 * canonical entities. We resolve in tiers, cheapest/most-reliable first.
 *
 * Implemented here: the offline tiers, so the pipeline runs end-to-end with no
 * network.
 *   Tier 3 — internal exact match against already-resolved entities, on a
 *     normalized key (composer+title for works, name for persons). Re-running
 *     therefore reuses slugs instead of minting duplicates.
 *   Tier 4 — mint a deterministic slug. These are provisional: served as-is, but
 *     a later Wikidata pass can fold them into a QID match.
 *   Tier 0 freebie — when a RawProduction already carries an authoritative work
 *     QID (the Wikidata backfill puts it in source_production_id), we key the
 *     work on that QID directly, which is as good as a Tier-1 hit.
 *
 * TODO(implementer): Tier 1 (Wikidata wbsearchentities, constrained by P106 /
 * instance-of opera Q1344) and Tier 2 (MusicBrainz) layer on top of these —
 * they only need to set `wikidata`/`musicbrainz_*` and re-key, the merge in the
 * store handles the rest.
 */

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

const WIKIDATA_PREFIX = "wikidata:";

/** Resolve one scraped production into canonical entities and upsert them all. */
export function ingestRawProduction(
  store: CanonicalStore,
  raw: RawProduction,
  houseSlug: Slug,
): void {
  const qid = raw.source_production_id.startsWith(WIKIDATA_PREFIX)
    ? raw.source_production_id.slice(WIKIDATA_PREFIX.length)
    : null;

  const work = resolveWork(store, raw.work_title, raw.composer_name, qid);
  // A Wikidata "location of first performance" hit is an authoritative world premiere.
  if (qid && raw.is_revival === false && raw.premiere_date && !work.world_premiere) {
    store.upsertWork({
      ...work,
      world_premiere: raw.premiere_date,
      world_premiere_house_slug: houseSlug,
    });
  }

  const creative_team: CreativeCredit[] = [];
  for (const c of raw.creative_team ?? []) {
    if (!c.function) continue; // un-normalized labels aren't creative functions
    const person = resolvePerson(store, c.name, c.function);
    if (person) creative_team.push({ person_slug: person.slug, function: c.function });
  }

  const cast = resolveCast(store, raw.cast, work.slug);

  const productionId = raw.premiere_season
    ? `${houseSlug}/${slugify(raw.work_title)}/${slugify(raw.premiere_season)}`
    : `${houseSlug}/${slugify(raw.source_production_id)}`;

  const production: Production = {
    id: productionId,
    work_slug: work.slug,
    house_slug: houseSlug,
    premiere_season: raw.premiere_season ?? null,
    premiere_date: raw.premiere_date ?? null,
    is_revival: raw.is_revival ?? false,
    language: raw.language ?? null,
    presentation_note: raw.presentation_note ?? null,
    detail_url: raw.detail_url ?? null,
    image_url: raw.image_url ?? null,
    synopsis: raw.synopsis ?? null,
    creative_team: sortCredits(creative_team),
    cast: sortCast(cast),
  };
  store.upsertProduction(production);

  for (const perf of raw.performances) {
    const id = `${productionId}/${perf.date}/${perf.time ?? ""}`;
    const perfCast = perf.cast?.length
      ? sortCast(resolveCast(store, perf.cast, work.slug))
      : undefined;
    const performance: Performance = {
      id,
      production_id: productionId,
      date: perf.date,
      time: perf.time ?? null,
      venue_room: perf.venue_room ?? null,
      status: perf.status ?? undefined,
      ticket_url: perf.ticket_url ?? null,
      cast: perfCast,
    };
    store.upsertPerformance(performance);
  }
}

function resolveCast(
  store: CanonicalStore,
  raw: RawProduction["cast"],
  workSlug: Slug,
): CastCredit[] {
  const out: CastCredit[] = [];
  for (const c of raw ?? []) {
    if (!c.role) continue; // a credit without a role isn't a sung part
    const person = resolvePerson(store, c.name, "singer");
    if (!person) continue;
    const role = resolveRole(store, c.role, workSlug);
    out.push({ person_slug: person.slug, role_slug: role.slug });
  }
  return out;
}

// ── Tier 3 (reuse) + Tier 4 (mint) per entity type ──────────────────────────

function resolveWork(
  store: CanonicalStore,
  title: string,
  composerName: string | null | undefined,
  qid: string | null,
): Work {
  const composer = composerName?.trim() ? resolvePerson(store, composerName, "composer") : null;
  const key = workKey(title, composerName);

  const existingSlug = (qid && store.worksByQid.get(qid)) || store.worksByKey.get(key);
  if (existingSlug) {
    const existing = store.works.get(existingSlug) as Work;
    // Attach the QID the first time a Wikidata source confirms this work.
    return qid && !existing.wikidata ? store.upsertWork({ ...existing, wikidata: qid }) : existing;
  }

  const titleSlug = slugify(title);
  const slug = composer ? `${composer.slug}/${titleSlug}` : titleSlug;
  return store.upsertWork({
    slug,
    wikidata: qid ?? null,
    title: title.trim(),
    composer_slug: composer?.slug ?? "",
  });
}

function resolvePerson(store: CanonicalStore, name: string, profession: string): Person | null {
  const clean = name.trim();
  if (!clean) return null;
  const slug = slugify(clean);
  if (!slug) return null;
  return store.upsertPerson({ slug, name: clean, professions: [profession] });
}

function resolveRole(store: CanonicalStore, roleName: string, workSlug: Slug): Role {
  const slug = `${workSlug}/${slugify(roleName)}`;
  return store.upsertRole({ slug, work_slug: workSlug, name: roleName.trim() });
}

// ── deterministic ordering for diff-stable output ───────────────────────────

function sortCredits(credits: CreativeCredit[]): CreativeCredit[] {
  return [...credits].sort(
    (a, b) => a.function.localeCompare(b.function) || a.person_slug.localeCompare(b.person_slug),
  );
}

function sortCast(cast: CastCredit[]): CastCredit[] {
  return [...cast].sort(
    (a, b) => a.role_slug.localeCompare(b.role_slug) || a.person_slug.localeCompare(b.person_slug),
  );
}
