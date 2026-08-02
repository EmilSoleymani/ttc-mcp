import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSchedule } from "./schedule-repository.js";
import { buildFixtureDb } from "./test-support.js";

describe("schedule repository", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  it("returns the next departure at a surface stop", async () => {
    const result = await getSchedule(client, {
      stopId: 663,
      when: new Date("2026-07-24T10:00:00-04:00"),
      limit: 1,
    });
    expect(result?.stop).toMatchObject({ stop_id: "663" });
    expect(result?.departures).toEqual([
      {
        route_id: "900",
        route_short_name: "900",
        headsign: "Airport",
        direction_id: 0,
        scheduled_time: "2026-07-25T06:20:00-04:00",
      },
    ]);
    // The fixture's service runs daily, so the day after also has a match —
    // confirming the anti-dump cap still applies once the lookahead finds
    // more candidates than requested.
    expect(result?.truncated).toBe(true);
  });

  it("aggregates a station's platforms, tagging each with platform_stop_id", async () => {
    const result = await getSchedule(client, {
      stopId: 9000,
      when: new Date("2026-07-24T00:00:00-04:00"),
      limit: 1,
    });
    expect(result?.departures).toEqual([
      expect.objectContaining({
        route_id: "1",
        headsign: "Finch",
        platform_stop_id: "9001",
        scheduled_time: "2026-07-24T06:00:00-04:00",
      }),
    ]);
  });

  it("filters by route_id", async () => {
    const result = await getSchedule(client, {
      stopId: 663,
      routeId: 1,
      when: new Date("2026-07-24T00:00:00-04:00"),
    });
    expect(result?.departures).toEqual([]);
  });

  it("caps departures and sets truncated + hint", async () => {
    const result = await getSchedule(client, {
      stopId: 663,
      when: new Date("2026-07-24T00:00:00-04:00"),
      limit: 1,
    });
    expect(result?.departures).toHaveLength(1);
    expect(result?.truncated).toBe(true);
    expect(result?.hint).toBeDefined();
  });

  it("omits the hint when a route_id filter is already narrowing", async () => {
    const result = await getSchedule(client, {
      stopId: 663,
      routeId: 900,
      when: new Date("2026-07-24T00:00:00-04:00"),
      limit: 1,
    });
    expect(result?.truncated).toBe(true);
    expect(result?.hint).toBeUndefined();
  });

  it("resolves a past-24:00:00 departure to the correct next-day timestamp", async () => {
    await client.execute({
      sql: `INSERT INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id, shape_id)
            VALUES (5, 1, 1, 'Finch', 0, NULL)`,
    });
    await client.execute({
      sql: `INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arr, dep)
            VALUES (5, 9001, 1, 90600, 90600)`,
    });

    const result = await getSchedule(client, {
      stopId: 9001,
      when: new Date("2026-07-24T22:00:00-04:00"),
    });
    expect(result?.departures[0]).toMatchObject({
      route_id: "1",
      scheduled_time: "2026-07-25T01:10:00-04:00",
    });
  });

  it("honors an added (exception_type 1) calendar_dates service on its exact date only", async () => {
    await client.execute({
      sql: `INSERT INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id, shape_id)
            VALUES (6, 900, 2, 'Special', 0, NULL)`,
    });
    await client.execute({
      sql: `INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arr, dep)
            VALUES (6, 662, 1, 36000, 36000)`,
    });
    await client.execute({
      sql: `INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (2, 20260725, 1)`,
    });

    const onDate = await getSchedule(client, {
      stopId: 662,
      routeId: 900,
      when: new Date("2026-07-25T00:00:00-04:00"),
    });
    expect(onDate?.departures).toContainEqual(
      expect.objectContaining({ headsign: "Special" }),
    );

    const offDate = await getSchedule(client, {
      stopId: 662,
      routeId: 900,
      // Far enough from 2026-07-25 that it falls outside the extended
      // lookahead window too (not just the base +-1-day window), so the
      // added service can't leak in via the forward search either.
      when: new Date("2026-07-01T00:00:00-04:00"),
    });
    expect(offDate?.departures.some((d) => d.headsign === "Special")).toBe(
      false,
    );
  });

  it("honors a removed (exception_type 2) calendar_dates exception", async () => {
    await client.execute({
      sql: `INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (1, 20260726, 2)`,
    });

    const result = await getSchedule(client, {
      stopId: 663,
      routeId: 900,
      when: new Date("2026-07-26T00:00:00-04:00"),
    });
    expect(
      result?.departures.some((d) => d.scheduled_time.startsWith("2026-07-26")),
    ).toBe(false);
    expect(
      result?.departures.some((d) => d.scheduled_time.startsWith("2026-07-27")),
    ).toBe(true);
  });

  it("returns undefined for an unknown stop_id", async () => {
    await expect(
      getSchedule(client, { stopId: 999_999, when: new Date() }),
    ).resolves.toBeUndefined();
  });

  it("extends the search forward when the base window has a real calendar gap (e.g. a board-period transition)", async () => {
    // Mirrors a real-world TTC GTFS quirk: a board period's calendar.txt can
    // start a couple of days in the future relative to "today", leaving a
    // genuine gap with zero active service in the immediate +-1-day window.
    await client.execute({
      sql: `INSERT INTO routes (route_id, route_short_name, route_long_name, route_type, route_color)
            VALUES (700, '700', 'Gap Test Route', 3, NULL)`,
    });
    await client.execute({
      sql: `INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
            VALUES (700, 1, 1, 1, 1, 1, 1, 1, 20260726, 20260905)`,
    });
    await client.execute({
      sql: `INSERT INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id, shape_id)
            VALUES (7, 700, 700, 'Gap Route', 0, NULL)`,
    });
    await client.execute({
      sql: `INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arr, dep)
            VALUES (7, 663, 1, 28800, 28800)`,
    });

    const result = await getSchedule(client, {
      stopId: 663,
      routeId: 700,
      when: new Date("2026-07-24T10:00:00-04:00"),
    });
    expect(result?.departures[0]).toMatchObject({
      route_id: "700",
      scheduled_time: "2026-07-26T08:00:00-04:00",
    });
    expect(result?.hint).toContain("next available service day");
  });

  it("reports no service found when the entire lookahead window has none", async () => {
    await client.execute({
      sql: `INSERT INTO routes (route_id, route_short_name, route_long_name, route_type, route_color)
            VALUES (701, '701', 'Far Future Route', 3, NULL)`,
    });
    await client.execute({
      sql: `INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
            VALUES (701, 1, 1, 1, 1, 1, 1, 1, 20261001, 20261231)`,
    });
    await client.execute({
      sql: `INSERT INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id, shape_id)
            VALUES (8, 701, 701, 'Far Future', 0, NULL)`,
    });
    await client.execute({
      sql: `INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arr, dep)
            VALUES (8, 663, 1, 28800, 28800)`,
    });

    const result = await getSchedule(client, {
      stopId: 663,
      routeId: 701,
      when: new Date("2026-07-24T10:00:00-04:00"),
    });
    expect(result?.departures).toEqual([]);
    expect(result?.hint).toBe(
      "No scheduled service found in the next 14 days.",
    );
  });

  it("returns tonight's remaining departures at a stop busier than the old cap", async () => {
    // Trip 700 on route 900 (service 1). Give stop 662 a full day of
    // departures: 600 in the morning (00:00–10:00) plus two in the evening.
    // The old LIMIT-500 fetch kept only the earliest 500 (all morning), so an
    // evening query wrongly returned the NEXT day. The windowed fetch must
    // return 20:00 TODAY.
    await client.execute({
      sql: `INSERT INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id, shape_id)
            VALUES (700, 900, 1, 'Loop', 0, NULL)`,
    });
    const rows: string[] = [];
    const args: number[] = [];
    for (let i = 0; i < 600; i++) {
      rows.push("(700, 662, 1, ?, ?)");
      args.push(i * 60, i * 60); // 00:00:00 .. 09:59:00
    }
    rows.push("(700, 662, 1, ?, ?)"); // 20:00:00
    args.push(72000, 72000);
    rows.push("(700, 662, 1, ?, ?)"); // 20:30:00
    args.push(73800, 73800);
    await client.execute({
      sql: `INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arr, dep) VALUES ${rows.join(", ")}`,
      args,
    });

    const result = await getSchedule(client, {
      stopId: 662,
      routeId: 900,
      when: new Date("2026-07-24T20:00:00-04:00"),
      limit: 5,
    });
    expect(result?.departures[0]?.scheduled_time).toMatch(/^2026-07-24T20:00/);
    expect(result?.truncated).toBe(true);
  });
});
