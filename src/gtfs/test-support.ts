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

/**
 * A small routing network for plan_trip's query-layer and ladder tests
 * (docs/superpowers/specs/2026-08-04-plan-trip-design.md). Distinct id range
 * from `buildFixtureDb` so the two never collide.
 *
 * Geometry (a two-seat ride with a street interchange):
 *
 *   route 10 (subway):  101 --- 102 --- 103
 *                                         | street transfer (90 s)
 *   route 20 (bus):     201 --- 202 --< 203  "Broadview Station"
 *                                       \  204  "Broadview Junction"   (branch)
 *   route 30 (streetcar): 301 --- 302 --- 303   (standalone, 09:00)
 *
 * - route 10 has a normal trip (100, 08:00), a later trip (101, 08:30) — for
 *   per-stop threshold / earliest-per-pattern tests — and a past-midnight trip
 *   (102, 25:00) for the windowed service-day time base.
 * - route 20 direction 0 splits after 202 into two headsigns (two patterns).
 * - route 30 (route_type 0) is an isolated streetcar line so a plan can
 *   exercise a `mode: "streetcar"` leg end-to-end.
 * - "Broadview Station"/"Broadview Junction" share a name substring → an
 *   ambiguous name-resolution case; "Distillery Loop" is unique.
 */
export async function buildRoutingFixtureDb(): Promise<Client> {
  const dbDir = mkdtempSync(join(tmpdir(), "ttc-routing-fixture-"));
  const client = createClient({ url: `file:${join(dbDir, "fixture.db")}` });
  await applySchema(client);

  await loadTable(
    client,
    spec("routes"),
    asRecords([
      {
        route_id: "10",
        route_short_name: "10",
        route_long_name: "Line A",
        route_type: "1",
        route_color: "",
      },
      {
        route_id: "20",
        route_short_name: "20",
        route_long_name: "Route B",
        route_type: "3",
        route_color: "",
      },
      {
        route_id: "30",
        route_short_name: "30",
        route_long_name: "Streetcar C",
        route_type: "0",
        route_color: "",
      },
    ]),
  );

  const stopRow = (
    stop_id: string,
    stop_name: string,
    stop_lat: string,
    stop_lon: string,
  ): CsvRow => ({
    stop_id,
    stop_code: stop_id,
    stop_name,
    stop_lat,
    stop_lon,
    parent_station: "",
    location_type: "",
  });

  await loadTable(
    client,
    spec("stops"),
    asRecords([
      stopRow("101", "Distillery Loop", "43.650000", "-79.380000"),
      stopRow("102", "Midtown", "43.655000", "-79.380000"),
      stopRow("103", "Junction Interchange", "43.660000", "-79.380000"),
      stopRow("201", "Riverside", "43.660100", "-79.379900"),
      stopRow("202", "Eastgate", "43.665000", "-79.375000"),
      stopRow("203", "Broadview Station", "43.670000", "-79.370000"),
      stopRow("204", "Broadview Junction", "43.665000", "-79.370000"),
      // A standalone streetcar (route 30) line, well away from the rest so it
      // never perturbs the subway/bus network's exact-match assertions or the
      // coordinate-snap test point.
      stopRow("301", "Harbourfront Loop", "43.630000", "-79.380000"),
      stopRow("302", "Queens Quay", "43.628000", "-79.385000"),
      stopRow("303", "Spadina Loop", "43.626000", "-79.390000"),
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

  const tripRow = (
    trip_id: string,
    route_id: string,
    trip_headsign: string,
  ): CsvRow => ({
    trip_id,
    route_id,
    service_id: "1",
    trip_headsign,
    direction_id: "0",
    shape_id: "",
  });

  await loadTable(
    client,
    spec("trips"),
    asRecords([
      tripRow("100", "10", "Aend"),
      tripRow("101", "10", "Aend"),
      tripRow("102", "10", "Aend"),
      tripRow("110", "20", "Broadview Station"),
      tripRow("111", "20", "Broadview Junction"),
      tripRow("300", "30", "Spadina Loop"),
    ]),
  );

  const st = (
    trip_id: string,
    stop_id: string,
    stop_sequence: string,
    time: string,
  ): CsvRow => ({
    trip_id,
    stop_id,
    stop_sequence,
    arrival_time: time,
    departure_time: time,
  });

  await loadTable(
    client,
    spec("stop_times"),
    asRecords([
      // route 10 — 08:00 trip
      st("100", "101", "1", "8:00:00"),
      st("100", "102", "2", "8:05:00"),
      st("100", "103", "3", "8:10:00"),
      // route 10 — 08:30 trip (a later earliest-per-pattern candidate)
      st("101", "101", "1", "8:30:00"),
      st("101", "102", "2", "8:35:00"),
      st("101", "103", "3", "8:40:00"),
      // route 10 — past-midnight trip (belongs to the prior service day)
      st("102", "101", "1", "25:00:00"),
      st("102", "102", "2", "25:05:00"),
      st("102", "103", "3", "25:10:00"),
      // route 20 — "Broadview Station" branch
      st("110", "201", "1", "8:15:00"),
      st("110", "202", "2", "8:20:00"),
      st("110", "203", "3", "8:30:00"),
      // route 20 — "Broadview Junction" branch (diverges after 202)
      st("111", "201", "1", "8:17:00"),
      st("111", "202", "2", "8:22:00"),
      st("111", "204", "3", "8:32:00"),
      // route 30 — the streetcar line
      st("300", "301", "1", "9:00:00"),
      st("300", "302", "2", "9:03:00"),
      st("300", "303", "3", "9:06:00"),
    ]),
  );

  // The street interchange between the subway (103) and the bus (201), both
  // ways. Inserted directly — the transfers table is generated at ingest, not
  // loaded from a GTFS file, so it has no TABLE_SPEC.
  await client.batch([
    {
      sql: "INSERT INTO transfers (from_stop_id, to_stop_id, min_walk_seconds, type) VALUES (?, ?, ?, ?)",
      args: [103, 201, 90, "street"],
    },
    {
      sql: "INSERT INTO transfers (from_stop_id, to_stop_id, min_walk_seconds, type) VALUES (?, ?, ?, ?)",
      args: [201, 103, 90, "street"],
    },
    // A `pathway` transfer — currently excluded by the routing layer (issue
    // #39: pathway rows carry an un-crosswalked Dataset B namespace).
    {
      sql: "INSERT INTO transfers (from_stop_id, to_stop_id, min_walk_seconds, type) VALUES (?, ?, ?, ?)",
      args: [202, 203, 30, "pathway"],
    },
  ]);

  return client;
}
