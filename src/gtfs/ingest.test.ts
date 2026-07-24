import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Client, createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  type CsvRow,
  loadTable,
  type TableSpec,
  TABLE_SPECS,
} from "./ingest.js";
import { applySchema } from "./schema.js";

function spec(table: string): TableSpec {
  const found = TABLE_SPECS.find((s) => s.table === table);
  if (!found) throw new Error(`no spec for ${table}`);
  return found;
}

async function* asRecords(records: CsvRow[]): AsyncIterable<CsvRow> {
  await Promise.resolve();
  for (const record of records) yield record;
}

// A shared on-disk libSQL db per test: an in-memory (":memory:") url gives each
// connection (execute vs. transaction) its own database, so the write
// transaction wouldn't see applySchema's tables.
let dbDir: string | undefined;
function freshDb(): Client {
  dbDir = mkdtempSync(join(tmpdir(), "ttc-ingest-test-"));
  return createClient({ url: `file:${join(dbDir, "t.db")}` });
}
afterEach(() => {
  if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  dbDir = undefined;
});

describe("GTFS ingest into libSQL", () => {
  it("applies the schema and loads typed, int-time rows queryable by the stop/dep index", async () => {
    const client = freshDb();
    await applySchema(client);

    const stopCount = await loadTable(
      client,
      spec("stops"),
      asRecords([
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
          stop_id: "929",
          stop_code: "",
          stop_name: "Platform with no code",
          stop_lat: "43.7",
          stop_lon: "-79.2",
          parent_station: "662",
          location_type: "0",
        },
      ]),
    );
    expect(stopCount).toBe(2);

    await loadTable(
      client,
      spec("stop_times"),
      asRecords([
        {
          trip_id: "1",
          stop_id: "662",
          stop_sequence: "1",
          arrival_time: "6:32:37",
          departure_time: "6:32:37",
        },
        {
          trip_id: "2",
          stop_id: "662",
          stop_sequence: "1",
          arrival_time: "6:05:00",
          departure_time: "6:05:00",
        },
        {
          trip_id: "3",
          stop_id: "662",
          stop_sequence: "1",
          arrival_time: "25:10:00",
          departure_time: "25:10:00",
        },
      ]),
    );

    const stops = await client.execute("SELECT count(*) AS n FROM stops");
    expect(Number(stops.rows[0]!.n)).toBe(2);

    // Blank stop_code became NULL (subway platforms lack codes), not 0.
    const noCode = await client.execute(
      "SELECT stop_code FROM stops WHERE stop_id = 929",
    );
    expect(noCode.rows[0]!.stop_code).toBeNull();

    // The core "next departures at a stop after T" query, ordered by int dep.
    const next = await client.execute({
      sql: "SELECT trip_id, dep FROM stop_times WHERE stop_id = ? AND dep >= ? ORDER BY dep LIMIT 2",
      args: [662, 6 * 3600],
    });
    expect(next.rows.map((r) => Number(r.dep))).toEqual([
      6 * 3600 + 5 * 60, // 6:05:00
      6 * 3600 + 32 * 60 + 37, // 6:32:37
    ]);

    // Query is index-driven, not a full table scan.
    const plan = await client.execute({
      sql: "EXPLAIN QUERY PLAN SELECT trip_id, dep FROM stop_times WHERE stop_id = ? AND dep >= ? ORDER BY dep",
      args: [662, 0],
    });
    expect(JSON.stringify(plan.rows)).toContain("ix_st_stop_dep");

    client.close();
  });

  it("maps every table spec without throwing", async () => {
    const client = freshDb();
    await applySchema(client);
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
          saturday: "0",
          sunday: "0",
          start_date: "20260726",
          end_date: "20260905",
        },
      ]),
    );
    await loadTable(
      client,
      spec("calendar_dates"),
      asRecords([{ service_id: "501", date: "20260727", exception_type: "1" }]),
    );
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
      ]),
    );
    await loadTable(
      client,
      spec("trips"),
      asRecords([
        {
          route_id: "1",
          service_id: "1",
          trip_id: "50658032",
          trip_headsign: "towards VMC",
          direction_id: "0",
          shape_id: "1119099",
        },
      ]),
    );

    const route = await client.execute(
      "SELECT route_type, route_color FROM routes WHERE route_id = 1",
    );
    expect(Number(route.rows[0]!.route_type)).toBe(1);
    expect(route.rows[0]!.route_color).toBe("D5C82B");
    client.close();
  });
});
