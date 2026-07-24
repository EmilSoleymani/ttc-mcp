import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ingestScheduleZip } from "./ingest.js";

const FIXTURE_ZIP = fileURLToPath(
  new URL("../../test/fixtures/gtfs/mini-schedules.zip", import.meta.url),
);

describe("ingestScheduleZip", () => {
  let local: Client;
  let remote: Client;

  beforeEach(() => {
    // Two independent in-memory clients stand in for "the local libSQL file"
    // and "the remote Turso database" — same @libsql/client codepath either
    // way (docs/spec/gtfs-ingestion.md §1), so writing to both here proves
    // the multi-target sync without needing live Turso credentials.
    local = createClient({ url: ":memory:" });
    remote = createClient({ url: ":memory:" });
  });

  afterEach(() => {
    local.close();
    remote.close();
  });

  it("loads every schedule table with row counts matching the fixture", async () => {
    const summary = await ingestScheduleZip(FIXTURE_ZIP, [local, remote]);

    expect(summary).toEqual({
      stops: 4,
      routes: 3,
      trips: 2,
      stopTimes: 4,
      calendar: 1,
      calendarDates: 1,
    });
  });

  it("writes identical data to every target client", async () => {
    await ingestScheduleZip(FIXTURE_ZIP, [local, remote]);

    for (const client of [local, remote]) {
      const stops = await client.execute("SELECT COUNT(*) AS n FROM stops");
      expect(stops.rows[0]?.["n"]).toBe(4);
      const stopTimes = await client.execute(
        "SELECT COUNT(*) AS n FROM stop_times",
      );
      expect(stopTimes.rows[0]?.["n"]).toBe(4);
    }
  });

  it("aggregates a station's child platforms via parent_station", async () => {
    await ingestScheduleZip(FIXTURE_ZIP, [local]);

    const station = await local.execute({
      sql: "SELECT stop_name, parent_station FROM stops WHERE stop_id = ?",
      args: [10001],
    });
    expect(station.rows[0]?.["parent_station"]).toBeNull();

    const platforms = await local.execute({
      sql: "SELECT stop_id FROM stops WHERE parent_station = ?",
      args: [10001],
    });
    expect(platforms.rows.map((r) => r["stop_id"]).sort()).toEqual([
      10002, 10003,
    ]);
  });

  it("stores past-midnight GTFS times as seconds without wrapping", async () => {
    await ingestScheduleZip(FIXTURE_ZIP, [local]);

    const row = await local.execute({
      sql: "SELECT arr, dep FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
      args: [900002, 1],
    });
    expect(row.rows[0]?.["arr"]).toBe(25 * 3600 + 10 * 60);
  });

  it("is idempotent — re-ingesting replaces rather than duplicates", async () => {
    await ingestScheduleZip(FIXTURE_ZIP, [local]);
    const summary = await ingestScheduleZip(FIXTURE_ZIP, [local]);

    expect(summary.stopTimes).toBe(4);
    const count = await local.execute("SELECT COUNT(*) AS n FROM stop_times");
    expect(count.rows[0]?.["n"]).toBe(4);
  });
});
