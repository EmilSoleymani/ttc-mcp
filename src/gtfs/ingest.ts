import { type Client, type InValue } from "@libsql/client";

import { gtfsTimeToSeconds, toInt, toReal } from "./transform.js";

/** Dataset A — "TTC Routes and Schedules" (open.toronto.ca / CKAN, ~6-week refresh). */
export const DEFAULT_SCHEDULES_URL =
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/opendata_ttc_schedules.zip";

/** Dataset B — "merged-gtfs-ttc-routes-and-schedules" (quarterly). Only its
 * pathways.txt/levels.txt are used — everything else is Dataset A's job. */
export const DEFAULT_MERGED_URL =
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/b811ead4-6eaf-4adb-8408-d389fb5a069c/resource/c920e221-7a1c-488b-8c5b-6d8cd4e85eaf/download/completegtfs.zip";

export type CsvRow = Record<string, string | undefined>;

export interface TableSpec {
  table: string;
  file: string;
  columns: readonly string[];
  mapRow: (row: CsvRow) => InValue[];
}

// One spec per GTFS file → optimized table. Loaded stop_times last (largest).
export const TABLE_SPECS: readonly TableSpec[] = [
  {
    table: "calendar",
    file: "calendar.txt",
    columns: [
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
    ],
    mapRow: (r) => [
      toInt(r.service_id),
      toInt(r.monday),
      toInt(r.tuesday),
      toInt(r.wednesday),
      toInt(r.thursday),
      toInt(r.friday),
      toInt(r.saturday),
      toInt(r.sunday),
      toInt(r.start_date),
      toInt(r.end_date),
    ],
  },
  {
    table: "calendar_dates",
    file: "calendar_dates.txt",
    columns: ["service_id", "date", "exception_type"],
    mapRow: (r) => [
      toInt(r.service_id),
      toInt(r.date),
      toInt(r.exception_type),
    ],
  },
  {
    table: "routes",
    file: "routes.txt",
    columns: [
      "route_id",
      "route_short_name",
      "route_long_name",
      "route_type",
      "route_color",
    ],
    mapRow: (r) => [
      toInt(r.route_id),
      r.route_short_name ?? null,
      r.route_long_name ?? null,
      toInt(r.route_type),
      r.route_color ?? null,
    ],
  },
  {
    table: "stops",
    file: "stops.txt",
    columns: [
      "stop_id",
      "stop_code",
      "stop_name",
      "stop_lat",
      "stop_lon",
      "parent_station",
      "location_type",
    ],
    mapRow: (r) => [
      toInt(r.stop_id),
      toInt(r.stop_code),
      r.stop_name ?? "",
      toReal(r.stop_lat),
      toReal(r.stop_lon),
      toInt(r.parent_station),
      toInt(r.location_type),
    ],
  },
  {
    table: "trips",
    file: "trips.txt",
    columns: [
      "trip_id",
      "route_id",
      "service_id",
      "trip_headsign",
      "direction_id",
      "shape_id",
    ],
    mapRow: (r) => [
      toInt(r.trip_id),
      toInt(r.route_id),
      toInt(r.service_id),
      r.trip_headsign ?? null,
      toInt(r.direction_id),
      toInt(r.shape_id),
    ],
  },
  {
    table: "stop_times",
    file: "stop_times.txt",
    columns: ["trip_id", "stop_id", "stop_sequence", "arr", "dep"],
    mapRow: (r) => [
      toInt(r.trip_id),
      toInt(r.stop_id),
      toInt(r.stop_sequence),
      gtfsTimeToSeconds(r.arrival_time),
      gtfsTimeToSeconds(r.departure_time),
    ],
  },
];

// Dataset B files → the pathways/levels tables (#5's subway interchange
// graph). levels first: harmless either order since neither FKs the other.
export const MERGED_TABLE_SPECS: readonly TableSpec[] = [
  {
    table: "levels",
    file: "levels.txt",
    columns: ["level_id", "level_index", "level_name"],
    mapRow: (r) => [
      r.level_id ?? null,
      toReal(r.level_index),
      r.level_name ?? null,
    ],
  },
  {
    table: "pathways",
    file: "pathways.txt",
    columns: [
      "pathway_id",
      "from_stop_id",
      "to_stop_id",
      "pathway_mode",
      "is_bidirectional",
      "traversal_time",
      "length",
    ],
    mapRow: (r) => [
      r.pathway_id ?? null,
      toInt(r.from_stop_id),
      toInt(r.to_stop_id),
      toInt(r.pathway_mode),
      toInt(r.is_bidirectional),
      toInt(r.traversal_time),
      toReal(r.length),
    ],
  },
];

// Rows per multi-row INSERT. stop_times has 5 cols → 2,500 bound params/stmt,
// well under SQLite's variable limit.
const CHUNK_ROWS = 500;

/**
 * Streams the CSV records of one table into libSQL inside a single write
 * transaction, using multi-row INSERTs. Returns the row count.
 */
export async function loadTable(
  client: Client,
  spec: TableSpec,
  records: AsyncIterable<CsvRow>,
): Promise<number> {
  const colList = spec.columns.join(", ");
  const rowPlaceholder = `(${spec.columns.map(() => "?").join(", ")})`;
  const tx = await client.transaction("write");
  try {
    let count = 0;
    let args: InValue[] = [];
    let rowsInBatch = 0;
    const flush = async (): Promise<void> => {
      if (rowsInBatch === 0) return;
      const values = Array.from({ length: rowsInBatch }, () => rowPlaceholder);
      await tx.execute({
        sql: `INSERT INTO ${spec.table} (${colList}) VALUES ${values.join(", ")}`,
        args,
      });
      args = [];
      rowsInBatch = 0;
    };
    for await (const record of records) {
      args.push(...spec.mapRow(record));
      rowsInBatch += 1;
      count += 1;
      if (rowsInBatch >= CHUNK_ROWS) await flush();
    }
    await flush();
    await tx.commit();
    return count;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
