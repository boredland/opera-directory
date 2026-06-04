/**
 * opera.directory canonical data model.
 *
 * The central insight that separates this project from the flat event feeds
 * in the museumsufer monorepo: an opera *production* is a long-lived, richly
 * related entity, not a single dated event. One production of "Carmen" at a
 * house spans dozens of dated performances across one or more seasons, shares
 * a creative team, and stages a *work* that exists independently of any house.
 *
 * So the model is relational, with five canonical entities and the join rows
 * that connect them. The scrape layer emits loosely-typed `Raw*` rows; the
 * ingest layer resolves them against the canonical registries and upserts.
 *
 * Stable identity rules:
 *   - Work    → keyed on Wikidata QID when resolvable, else `composer-slug/title-slug`.
 *   - Person  → keyed on Wikidata QID, else `name-slug` (+ disambiguating role).
 *   - House   → curated slug from data/houses.json (never auto-minted).
 *   - Production → `house-slug/work-slug/premiere-season` when the season is
 *     known (e.g. Wikidata premieres); otherwise `house-slug/source-id`, since a
 *     live spielplan rarely exposes a premiere season and the house's own stable
 *     production slug already disambiguates revivals.
 *   - Performance → `production-id/date/time`.
 */

export type Slug = string;
/** Wikidata entity id, e.g. "Q727". */
export type QID = string;
/** ISO 639-1, e.g. "de", "it". */
export type LangCode = string;
/** ISO 8601 date, YYYY-MM-DD. */
export type IsoDate = string;

// ── Canonical entities ──────────────────────────────────────────────────────

/** The opera as an abstract work — independent of any staging. */
export interface Work {
  slug: Slug;
  wikidata?: QID | null;
  /** Title in its original language. */
  title: string;
  /** ISO 639-1 of the original libretto. */
  origin_language?: LangCode | null;
  composer_slug: Slug;
  librettist_slugs?: Slug[];
  /** First performance ever, anywhere. */
  world_premiere?: IsoDate | null;
  world_premiere_house_slug?: Slug | null;
  /** Free-form genre tag from upstream / Wikidata (opera seria, Singspiel, …). */
  genre?: string | null;
  acts?: number | null;
  /** Localized titles keyed by lang code, for display + matching aliases. */
  titles?: Record<LangCode, string>;
  musicbrainz_work?: string | null;
}

/** A character/part in a work (Carmen, Don José, …). */
export interface Role {
  slug: Slug;
  work_slug: Slug;
  name: string;
  /** soprano | mezzo-soprano | tenor | baritone | bass | countertenor | … */
  voice_type?: string | null;
}

/** A composer, conductor, director, singer, or designer. */
export interface Person {
  slug: Slug;
  wikidata?: QID | null;
  name: string;
  /** Roles a person is known for, used only as a search/index hint. */
  professions?: string[];
  born?: IsoDate | null;
  died?: IsoDate | null;
  musicbrainz_artist?: string | null;
}

/** An opera house / company / festival. Curated, never auto-minted. */
export interface House {
  slug: Slug;
  wikidata?: QID | null;
  name: string;
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  website?: string | null;
  lat?: number | null;
  lon?: number | null;
}

/** A staging of a Work at a House — the heart of the dataset. */
export interface Production {
  id: string; // house-slug/work-slug/premiere-season
  work_slug: Slug;
  house_slug: Slug;
  /** e.g. "2025/26". */
  premiere_season?: string | null;
  /** First night of *this* production. */
  premiere_date?: IsoDate | null;
  is_revival?: boolean;
  /** Co-producing houses (Koproduktion). */
  coproduction_house_slugs?: Slug[];
  language?: LangCode | null;
  /** Sung in original, surtitled, sung in translation, concert performance, … */
  presentation_note?: string | null;
  detail_url?: string | null;
  image_url?: string | null;
  synopsis?: string | null;
  /** Creative team — production-level, role keyed (Regie, Bühne, Kostüm, …). */
  creative_team: CreativeCredit[];
  /** The standing run cast (role → singer). Per-night jump-ins live on
   *  Performance.cast; this is what a performance inherits when it has none. */
  cast: CastCredit[];
}

/** A single dated showing of a production. */
export interface Performance {
  id: string; // production-id/date/time
  production_id: string;
  date: IsoDate;
  time?: string | null; // HH:MM
  venue_room?: string | null;
  status?: "scheduled" | "cancelled" | "sold_out" | "few_left" | "past";
  ticket_url?: string | null;
  /** Performance-level cast — captures jump-ins / alternating casts when the
   *  house publishes per-night casting. Falls back to production-level when not. */
  cast?: CastCredit[];
}

// ── Join rows ─────────────────────────────────────────────────────────────

export interface CreativeCredit {
  person_slug: Slug;
  /** conductor | director | set-designer | costume-designer | lighting |
   *  choreographer | dramaturgy | chorus-master | … */
  function: string;
}

export interface CastCredit {
  person_slug: Slug;
  role_slug: Slug;
  /** alternate cast / cover when the house distinguishes them. */
  is_cover?: boolean;
}
