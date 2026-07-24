import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Client, createClient } from "@libsql/client";

import {
  type CsvRow,
  loadTable,
  TABLE_SPECS,
  type TableSpec,
} from "./ingest.js";
import { applySchema } from "./schema.js";

async function* asRecords(records: CsvRow[]): AsyncIterable<CsvRow> {
  await Promise.resolve();
  for (const record of records) yield record;
}

function spec(table: string): TableSpec {
  const found = TABLE_SPECS.find((s) => s.table === table);
  if (!found) throw new Error(`no spec for ${table}`);
  return found;
}

/**
 * A small, realistic in-memory GTFS fixture shared by the stop-catalog tests:
 * a subway station (Union, one platform) on Line 1, two surface bus stops on
 * route 900, and an unserved "entrance" row (no trips reference it) to
 * exercise the not-a-real-stop edge case.
 */
export async function buildFixtureDb(): Promise<Client> {
  // A real on-disk file, not ":memory:" — an in-memory url gives each
  // connection its own database, so the write transaction inside loadTable
  // wouldn't see the tables applySchema just created (see ingest.test.ts).
  // Left on disk for the ephemeral test-run container to reclaim.
  const dbDir = mkdtempSync(join(tmpdir(), "ttc-stops-fixture-"));
  const client = createClient({ url: `file:${join(dbDir, "fixture.db")}` });
  await applySchema(client);

  await loadTable(
    client,
    spec("routes"),
    asRecords([
      {
        route_id: "1",
        route_short_name: "1",
        route_long_name: "Line 1 (Yonge-University)",
        route_type: "1",
        route_color: "D5C82B",
      },
      {
        route_id: "900",
        route_short_name: "900",
        route_long_name: "Airport Express",
        route_type: "3",
        route_color: "",
      },
    ]),
  );

  await loadTable(
    client,
    spec("stops"),
    asRecords([
      {
        stop_id: "9000",
        stop_code: "",
        stop_name: "Union Station",
        stop_lat: "43.645286",
        stop_lon: "-79.380875",
        parent_station: "",
        location_type: "1",
      },
      {
        stop_id: "9001",
        stop_code: "",
        stop_name: "Union Station - Platform 1",
        stop_lat: "43.645300",
        stop_lon: "-79.380900",
        parent_station: "9000",
        location_type: "0",
      },
      {
        stop_id: "9002",
        stop_code: "",
        stop_name: "Union Station - Front St Entrance",
        stop_lat: "43.645100",
        stop_lon: "-79.380700",
        parent_station: "",
        location_type: "2",
      },
      {
        stop_id: "662",
        stop_code: "662",
        stop_name: "Danforth Rd at Kennedy Rd",
        stop_lat: "43.714379",
        stop_lon: "-79.260939",
        parent_station: "",
        location_type: "",
      },
      {
        stop_id: "663",
        stop_code: "663",
        stop_name: "Kennedy Station Bus Bay",
        stop_lat: "43.732310",
        stop_lon: "-79.264840",
        parent_station: "",
        location_type: "",
      },
    ]),
  );

  await loadTable(
    client,
    spec("calendar"),
    asRecords([
      {
        service_id: "1",
        monday: "1",
        tuesday: "1",
        wednesday: "1",
        thursday: "1",
        friday: "1",
        saturday: "1",
        sunday: "1",
        start_date: "20260101",
        end_date: "20261231",
      },
    ]),
  );

  await loadTable(
    client,
    spec("trips"),
    asRecords([
      {
        trip_id: "1",
        route_id: "1",
        service_id: "1",
        trip_headsign: "Finch",
        direction_id: "0",
        shape_id: "",
      },
      {
        trip_id: "2",
        route_id: "900",
        service_id: "1",
        trip_headsign: "Airport",
        direction_id: "0",
        shape_id: "",
      },
    ]),
  );

  await loadTable(
    client,
    spec("stop_times"),
    asRecords([
      {
        trip_id: "1",
        stop_id: "9001",
        stop_sequence: "1",
        arrival_time: "6:00:00",
        departure_time: "6:00:00",
      },
      {
        trip_id: "2",
        stop_id: "662",
        stop_sequence: "1",
        arrival_time: "6:10:00",
        departure_time: "6:10:00",
      },
      {
        trip_id: "2",
        stop_id: "663",
        stop_sequence: "2",
        arrival_time: "6:20:00",
        departure_time: "6:20:00",
      },
    ]),
  );

  return client;
}
