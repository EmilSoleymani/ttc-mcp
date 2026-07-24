import type { Client } from "@libsql/client";

// Optimized typed schedule schema (docs/spec/gtfs-ingestion.md): integer
// surrogate keys, integer seconds-since-midnight times, essential columns
// only. transfers/pathways/levels are added by later slices (#5, #10).
export const SCHEMA_STATEMENTS: readonly string[] = [
  "DROP TABLE IF EXISTS transfers",
  "DROP TABLE IF EXISTS pathways",
  "DROP TABLE IF EXISTS levels",
  "DROP TABLE IF EXISTS stop_times",
  "DROP TABLE IF EXISTS trips",
  "DROP TABLE IF EXISTS calendar_dates",
  "DROP TABLE IF EXISTS calendar",
  "DROP TABLE IF EXISTS routes",
  "DROP TABLE IF EXISTS stops",
  `CREATE TABLE stops (
     stop_id INTEGER PRIMARY KEY,
     stop_code INTEGER,
     stop_name TEXT NOT NULL,
     stop_lat REAL,
     stop_lon REAL,
     parent_station INTEGER,
     location_type INTEGER
   )`,
  `CREATE TABLE routes (
     route_id INTEGER PRIMARY KEY,
     route_short_name TEXT,
     route_long_name TEXT,
     route_type INTEGER NOT NULL,
     route_color TEXT
   )`,
  `CREATE TABLE calendar (
     service_id INTEGER PRIMARY KEY,
     monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER,
     friday INTEGER, saturday INTEGER, sunday INTEGER,
     start_date INTEGER, end_date INTEGER
   )`,
  `CREATE TABLE calendar_dates (
     service_id INTEGER NOT NULL,
     date INTEGER NOT NULL,
     exception_type INTEGER NOT NULL
   )`,
  `CREATE TABLE trips (
     trip_id INTEGER PRIMARY KEY,
     route_id INTEGER NOT NULL,
     service_id INTEGER NOT NULL,
     trip_headsign TEXT,
     direction_id INTEGER,
     shape_id INTEGER
   )`,
  `CREATE TABLE stop_times (
     trip_id INTEGER NOT NULL,
     stop_id INTEGER NOT NULL,
     stop_sequence INTEGER NOT NULL,
     arr INTEGER,
     dep INTEGER
   )`,
  "CREATE INDEX ix_stops_code ON stops(stop_code)",
  "CREATE INDEX ix_stops_parent ON stops(parent_station)",
  "CREATE INDEX ix_trips_route ON trips(route_id)",
  "CREATE INDEX ix_trips_service ON trips(service_id)",
  "CREATE INDEX ix_st_stop_dep ON stop_times(stop_id, dep)",
  "CREATE INDEX ix_st_trip_seq ON stop_times(trip_id, stop_sequence)",
  "CREATE INDEX ix_cd_service_date ON calendar_dates(service_id, date)",
  // Dataset B (pathways/levels) — subway in-station interchange graph.
  `CREATE TABLE levels (
     level_id TEXT PRIMARY KEY,
     level_index REAL,
     level_name TEXT
   )`,
  `CREATE TABLE pathways (
     pathway_id TEXT,
     from_stop_id INTEGER NOT NULL,
     to_stop_id INTEGER NOT NULL,
     pathway_mode INTEGER,
     is_bidirectional INTEGER,
     traversal_time INTEGER,
     length REAL
   )`,
  // The synthesized transfers table (#5) — the missing transfers.txt,
  // generated at ingest from station/pathway/street derivation.
  `CREATE TABLE transfers (
     from_stop_id INTEGER NOT NULL,
     to_stop_id INTEGER NOT NULL,
     min_walk_seconds INTEGER NOT NULL,
     type TEXT NOT NULL
   )`,
  "CREATE INDEX ix_transfers_from ON transfers(from_stop_id)",
];

/** Drops and recreates the schedule schema (full-rebuild ingest). */
export async function applySchema(client: Client): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await client.execute(statement);
  }
}
