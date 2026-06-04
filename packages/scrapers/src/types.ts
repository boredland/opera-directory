import type { IsoDate, LangCode, Slug } from "@opera-directory/schema";

/**
 * The loosely-typed rows a house adapter emits. These are intentionally NOT
 * the canonical Production/Performance: a scraper only knows what the house's
 * own pages say (names as free text, no QIDs). The ingest layer is responsible
 * for resolving names → canonical Person/Work/Role slugs and minting ids.
 *
 * Keep adapters dumb and faithful: emit exactly what the page says, normalize
 * dates/times, and do NOT guess identity. Resolution is a separate, testable
 * pass so a bad fuzzy-match can't silently corrupt a scraper.
 */

export interface RawProduction {
  /** Stable upstream id for the production when available, else derived from detail_url. */
  source_production_id: string;
  work_title: string;
  composer_name?: string | null;
  premiere_season?: string | null;
  premiere_date?: IsoDate | null;
  is_revival?: boolean;
  language?: LangCode | null;
  presentation_note?: string | null;
  detail_url?: string | null;
  image_url?: string | null;
  synopsis?: string | null;
  /** Creative team as printed: { function: "Musikalische Leitung", name: "…" }. */
  creative_team?: RawCredit[];
  /** Cast as printed at the production level: { role: "Carmen", name: "…" }. */
  cast?: RawCredit[];
  performances: RawPerformance[];
}

export interface RawCredit {
  /** Verbatim upstream label — German or English. Normalized during ingest. */
  function?: string | null;
  role?: string | null;
  name: string;
}

export interface RawPerformance {
  date: IsoDate;
  time?: string | null;
  venue_room?: string | null;
  status?: "scheduled" | "cancelled" | "sold_out" | "few_left" | "past" | null;
  ticket_url?: string | null;
  /** Per-night cast when the house publishes it; else empty (inherits production cast). */
  cast?: RawCredit[];
}

export interface HouseScrapeResult {
  house_slug: Slug;
  /** Productions covering both the archive (past) and the announced spielplan (future). */
  productions: RawProduction[];
}

import type { FetchContext } from "./fetch";

export type HouseScraper = (ctx: FetchContext) => Promise<HouseScrapeResult>;

/** Registry entry shape mirrored in data/houses.json. */
export interface HouseSource {
  slug: Slug;
  name: string;
  city: string;
  country: string;
  website: string;
  wikidata?: string;
  /** Which adapter strategy this house uses; drives the scraper module name. */
  strategy: SourceStrategy;
  /** Free-form notes for the implementer: archive URL patterns, API hints, gotchas. */
  notes?: string;
  /** Set false to skip in the scheduled run without deleting the entry. */
  enabled?: boolean;
}

/**
 * The recurring source shapes across houses. Most European houses fall into
 * one of these; pick the cheapest that yields complete cast + creative data.
 */
export type SourceStrategy =
  | "jsonld-event" // schema.org Event/TheaterEvent JSON-LD in page <script>
  | "spielplan-html" // bespoke HTML spielplan + archive (like oper-frankfurt)
  | "spektrix-api" // Spektrix ticketing JSON API
  | "tessitura-api" // Tessitura TNEW / REST
  | "wikidata-sparql" // backfill-only: past productions from Wikidata
  | "manual"; // hand-curated seed, no live scrape yet
