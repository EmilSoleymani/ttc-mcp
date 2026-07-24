/**
 * Optimized typed libSQL schema for the ingested GTFS static feed
 * (docs/spec/gtfs-ingestion.md §2). Integer surrogate keys (TTC's
 * stop_id/trip_id/route_id are themselves numeric), times stored as INTEGER
 * seconds-since-midnight (handles GTFS's >24:00:00 next-day times natively).
 *
 * Scope: schedule tables only (stops/routes/trips/stop_times/calendar/
 * calendar_dates). `pathways`/`levels`/`transfers` are a separate ingest
 * slice (ticket 009 / issue #5) and `shapes` is excluded from v1 entirely.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS stops (
    stop_id INTEGER PRIMARY KEY,
    stop_code TEXT,
    stop_name TEXT NOT NULL,
    stop_lat REAL NOT NULL,
    stop_lon REAL NOT NULL,
    parent_station INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS ix_stops_stop_code ON stops(stop_code)`,
  `CREATE INDEX IF NOT EXISTS ix_stops_parent_station ON stops(parent_station)`,

  `CREATE TABLE IF NOT EXISTS routes (
    route_id INTEGER PRIMARY KEY,
    route_short_name TEXT,
    route_long_name TEXT,
    route_type INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS trips (
    trip_id INTEGER PRIMARY KEY,
    route_id INTEGER NOT NULL,
    service_id TEXT NOT NULL,
    direction_id INTEGER,
    shape_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_trips_route_id ON trips(route_id)`,

  `CREATE TABLE IF NOT EXISTS stop_times (
    trip_id INTEGER NOT NULL,
    stop_id INTEGER NOT NULL,
    stop_sequence INTEGER NOT NULL,
    arr INTEGER NOT NULL,
    dep INTEGER NOT NULL
  )`,
  // Load-bearing index: "next departures at a stop" filters stop_id and
  // range-scans dep in the same index (docs/spec/gtfs-ingestion.md §2, §"the
  // measurement that drove the design").
  `CREATE INDEX IF NOT EXISTS ix_st_stop_dep ON stop_times(stop_id, dep)`,
  `CREATE INDEX IF NOT EXISTS ix_st_trip_seq ON stop_times(trip_id, stop_sequence)`,

  `CREATE TABLE IF NOT EXISTS calendar (
    service_id TEXT PRIMARY KEY,
    monday INTEGER NOT NULL,
    tuesday INTEGER NOT NULL,
    wednesday INTEGER NOT NULL,
    thursday INTEGER NOT NULL,
    friday INTEGER NOT NULL,
    saturday INTEGER NOT NULL,
    sunday INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS calendar_dates (
    service_id TEXT NOT NULL,
    date TEXT NOT NULL,
    exception_type INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_cd_service_date ON calendar_dates(service_id, date)`,
];

/** Tables an ingest run replaces wholesale, in FK-safe delete order. */
export const SCHEDULE_TABLES_DELETE_ORDER: readonly string[] = [
  "stop_times",
  "calendar_dates",
  "calendar",
  "trips",
  "routes",
  "stops",
];
