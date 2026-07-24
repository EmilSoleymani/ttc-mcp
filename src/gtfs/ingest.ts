import type { Client, InValue } from "@libsql/client";

import { streamCsvEntries } from "./csv-zip.js";
import { SCHEDULE_TABLES_DELETE_ORDER, SCHEMA_STATEMENTS } from "./schema.js";
import { parseGtfsTime } from "./time.js";

// Keeps a batch's flattened bound-parameter count comfortably under SQLite's
// (and libSQL's) default host-parameter ceiling, regardless of table width.
const MAX_BATCH_PARAMS = 900;

export interface IngestSummary {
  stops: number;
  routes: number;
  trips: number;
  stopTimes: number;
  calendar: number;
  calendarDates: number;
}

function toNullableText(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function toNullableInt(value: string | undefined): number | null {
  return value === undefined || value === "" ? null : Number(value);
}

function requireField(record: Record<string, string>, field: string): string {
  const value = record[field];
  if (value === undefined || value === "") {
    throw new Error(`Missing required GTFS field: ${field}`);
  }
  return value;
}

async function execOnAll(
  clients: readonly Client[],
  sql: string,
  args: readonly InValue[] = [],
): Promise<void> {
  await Promise.all(
    clients.map((client) => client.execute({ sql, args: args as InValue[] })),
  );
}

async function createSchema(clients: readonly Client[]): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await execOnAll(clients, statement);
  }
}

/** Wipes prior ingest data so a re-run is idempotent rather than appending duplicates. */
async function clearScheduleTables(clients: readonly Client[]): Promise<void> {
  for (const table of SCHEDULE_TABLES_DELETE_ORDER) {
    await execOnAll(clients, `DELETE FROM ${table}`);
  }
}

async function insertBatch(
  clients: readonly Client[],
  table: string,
  columns: readonly string[],
  rows: readonly InValue[][],
): Promise<void> {
  if (rows.length === 0) return;
  const rowPlaceholder = `(${columns.map(() => "?").join(",")})`;
  const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${rows
    .map(() => rowPlaceholder)
    .join(",")}`;
  const args = rows.flat();
  await execOnAll(clients, sql, args);
}

/**
 * Streams one CSV entry out of the zip, maps each row, and flushes to every
 * target client in fixed-size batches — never accumulates the full table in
 * memory. `mapRow` returning `null` skips a row (e.g. a malformed line).
 */
async function loadTable(
  zipPath: string,
  entryName: string,
  clients: readonly Client[],
  table: string,
  columns: readonly string[],
  mapRow: (record: Record<string, string>) => InValue[] | null,
): Promise<number> {
  const batchSize = Math.max(1, Math.floor(MAX_BATCH_PARAMS / columns.length));
  let count = 0;
  let batch: InValue[][] = [];

  for await (const record of streamCsvEntries(zipPath, entryName)) {
    const row = mapRow(record);
    if (row === null) continue;
    batch.push(row);
    count++;
    if (batch.length >= batchSize) {
      await insertBatch(clients, table, columns, batch);
      batch = [];
    }
  }
  await insertBatch(clients, table, columns, batch);
  return count;
}

const STOPS_COLUMNS = [
  "stop_id",
  "stop_code",
  "stop_name",
  "stop_lat",
  "stop_lon",
  "parent_station",
] as const;

function mapStopRow(record: Record<string, string>): InValue[] {
  return [
    Number(requireField(record, "stop_id")),
    toNullableText(record["stop_code"]),
    requireField(record, "stop_name"),
    Number(requireField(record, "stop_lat")),
    Number(requireField(record, "stop_lon")),
    toNullableInt(record["parent_station"]),
  ];
}

const ROUTES_COLUMNS = [
  "route_id",
  "route_short_name",
  "route_long_name",
  "route_type",
] as const;

function mapRouteRow(record: Record<string, string>): InValue[] {
  return [
    Number(requireField(record, "route_id")),
    toNullableText(record["route_short_name"]),
    toNullableText(record["route_long_name"]),
    Number(requireField(record, "route_type")),
  ];
}

const TRIPS_COLUMNS = [
  "trip_id",
  "route_id",
  "service_id",
  "direction_id",
  "shape_id",
] as const;

function mapTripRow(record: Record<string, string>): InValue[] {
  return [
    Number(requireField(record, "trip_id")),
    Number(requireField(record, "route_id")),
    requireField(record, "service_id"),
    toNullableInt(record["direction_id"]),
    toNullableText(record["shape_id"]),
  ];
}

const STOP_TIMES_COLUMNS = [
  "trip_id",
  "stop_id",
  "stop_sequence",
  "arr",
  "dep",
] as const;

function mapStopTimeRow(record: Record<string, string>): InValue[] {
  return [
    Number(requireField(record, "trip_id")),
    Number(requireField(record, "stop_id")),
    Number(requireField(record, "stop_sequence")),
    parseGtfsTime(requireField(record, "arrival_time")),
    parseGtfsTime(requireField(record, "departure_time")),
  ];
}

const CALENDAR_COLUMNS = [
  "service_id",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "start_date",
  "end_date",
] as const;

function mapCalendarRow(record: Record<string, string>): InValue[] {
  return [
    requireField(record, "service_id"),
    Number(requireField(record, "monday")),
    Number(requireField(record, "tuesday")),
    Number(requireField(record, "wednesday")),
    Number(requireField(record, "thursday")),
    Number(requireField(record, "friday")),
    Number(requireField(record, "saturday")),
    Number(requireField(record, "sunday")),
    requireField(record, "start_date"),
    requireField(record, "end_date"),
  ];
}

const CALENDAR_DATES_COLUMNS = [
  "service_id",
  "date",
  "exception_type",
] as const;

function mapCalendarDateRow(record: Record<string, string>): InValue[] {
  return [
    requireField(record, "service_id"),
    requireField(record, "date"),
    Number(requireField(record, "exception_type")),
  ];
}

/**
 * Ingests Dataset A's schedule tables (stops/routes/trips/stop_times/
 * calendar/calendar_dates) from a downloaded GTFS zip into every target
 * client, streaming throughout — `stop_times` (~4.2M rows) is never held in
 * memory (docs/spec/gtfs-ingestion.md §4). Idempotent: clears prior rows
 * before loading, so re-running against a refreshed zip replaces cleanly.
 */
export async function ingestScheduleZip(
  zipPath: string,
  clients: readonly Client[],
): Promise<IngestSummary> {
  await createSchema(clients);
  await clearScheduleTables(clients);

  const stops = await loadTable(
    zipPath,
    "stops.txt",
    clients,
    "stops",
    STOPS_COLUMNS,
    mapStopRow,
  );
  const routes = await loadTable(
    zipPath,
    "routes.txt",
    clients,
    "routes",
    ROUTES_COLUMNS,
    mapRouteRow,
  );
  const trips = await loadTable(
    zipPath,
    "trips.txt",
    clients,
    "trips",
    TRIPS_COLUMNS,
    mapTripRow,
  );
  const calendar = await loadTable(
    zipPath,
    "calendar.txt",
    clients,
    "calendar",
    CALENDAR_COLUMNS,
    mapCalendarRow,
  );
  const calendarDates = await loadTable(
    zipPath,
    "calendar_dates.txt",
    clients,
    "calendar_dates",
    CALENDAR_DATES_COLUMNS,
    mapCalendarDateRow,
  );
  // Loaded last: by far the largest stream (~4.2M rows in production).
  const stopTimes = await loadTable(
    zipPath,
    "stop_times.txt",
    clients,
    "stop_times",
    STOP_TIMES_COLUMNS,
    mapStopTimeRow,
  );

  return { stops, routes, trips, stopTimes, calendar, calendarDates };
}
