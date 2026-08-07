import { type Client } from "@libsql/client";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureDb } from "../gtfs/test-support.js";
import { predictedArrivals } from "./arrivals-repository.js";
import { fixtureTripUpdatesRtClient } from "./test-support.js";

const ScheduleRelationship =
  GtfsRealtimeBindings.transit_realtime.TripUpdate.StopTimeUpdate
    .ScheduleRelationship;

// Fixture routes/stops come from buildFixtureDb: route 900 (bus) serves
// stops 662 ("Danforth Rd at Kennedy Rd") then 663 ("Kennedy Station Bus
// Bay"), headsign "Airport", scheduled 06:10 / 06:20. We add crosswalk rows
// mapping RT stop ids 50662->662 and 50663->663.
async function seedCrosswalk(db: Client): Promise<void> {
  await db.execute(
    "INSERT INTO rt_stop_crosswalk (rt_stop_id, stop_id) VALUES (50662, 662), (50663, 663)",
  );
}

const soon = Math.floor(Date.now() / 1000) + 300;
const later = soon + 300;

describe("predictedArrivals", () => {
  let db: Client;
  beforeEach(async () => {
    db = await buildFixtureDb();
    await seedCrosswalk(db);
  });
  afterEach(() => {
    db.close();
  });

  it("recovers headsign/direction by matching the live stop list to a static pattern", async () => {
    const rt = fixtureTripUpdatesRtClient([
      {
        routeId: "900",
        tripId: "999999", // 0% joinable (matches nothing in static trips)
        stopTimeUpdates: [
          { stopId: "50662", arrivalSeconds: soon },
          { stopId: "50663", arrivalSeconds: later },
        ],
      },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals, truncated } = await predictedArrivals(
      db,
      updates,
      [662],
      undefined,
      new Date(),
      20,
    );
    expect(truncated).toBe(false);
    expect(arrivals).toHaveLength(1);
    // The trip_id join misses, but the ordered stop list [662,663] fingerprints
    // route 900's only pattern — so headsign/direction are recovered.
    expect(arrivals[0]).toMatchObject({
      route_id: "900",
      route_short_name: "900",
      headsign: "Airport",
      direction_id: 0,
      realtime: true,
      source: "predicted",
    });
    expect(arrivals[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("populates delay_seconds against the matched schedule (predicted − scheduled)", async () => {
    // Fixed times so the delay is deterministic regardless of wall clock:
    // route 900 is scheduled out of stop 662 at 06:10:00; predict 06:11:30.
    const scheduled662 = Math.floor(
      new Date("2026-07-24T06:10:00-04:00").getTime() / 1000,
    );
    const rt = fixtureTripUpdatesRtClient([
      {
        routeId: "900",
        tripId: "999999",
        stopTimeUpdates: [
          { stopId: "50662", arrivalSeconds: scheduled662 + 90 },
          { stopId: "50663", arrivalSeconds: scheduled662 + 690 },
        ],
      },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals } = await predictedArrivals(
      db,
      updates,
      [662],
      undefined,
      new Date("2026-07-24T06:00:00-04:00"),
      20,
    );
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]!.delay_seconds).toBe(90);
  });

  it("falls back to 'towards <terminal>' text with no delay when nothing matches", async () => {
    // Route 800 has no trips → no patterns → no confident match. The live
    // trip's terminal (last crosswalked stop, 663) names the direction.
    const rt = fixtureTripUpdatesRtClient([
      {
        routeId: "800",
        tripId: "424242",
        stopTimeUpdates: [
          { stopId: "50662", arrivalSeconds: soon },
          { stopId: "50663", arrivalSeconds: later },
        ],
      },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals } = await predictedArrivals(
      db,
      updates,
      [662],
      undefined,
      new Date(),
      20,
    );
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({
      route_id: "800",
      headsign: "towards Kennedy Station Bus Bay",
      direction_id: 0,
    });
    expect(arrivals[0]!.delay_seconds).toBeUndefined();
  });

  it("skips SKIPPED and NO_DATA stop-time updates", async () => {
    const rt = fixtureTripUpdatesRtClient([
      {
        routeId: "900",
        stopTimeUpdates: [
          {
            stopId: "50662",
            arrivalSeconds: soon,
            scheduleRelationship: ScheduleRelationship.SKIPPED,
          },
        ],
      },
      {
        routeId: "900",
        stopTimeUpdates: [
          {
            stopId: "50663",
            arrivalSeconds: later,
            scheduleRelationship: ScheduleRelationship.NO_DATA,
          },
        ],
      },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals } = await predictedArrivals(
      db,
      updates,
      [662, 663],
      undefined,
      new Date(),
      20,
    );
    expect(arrivals).toEqual([]);
  });

  it("skips past times and stops with no crosswalk row", async () => {
    const rt = fixtureTripUpdatesRtClient([
      {
        routeId: "900",
        stopTimeUpdates: [
          {
            stopId: "50662",
            arrivalSeconds: Math.floor(Date.now() / 1000) - 60,
          },
        ],
      },
      {
        routeId: "900",
        stopTimeUpdates: [{ stopId: "77777", arrivalSeconds: soon }],
      },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals } = await predictedArrivals(
      db,
      updates,
      [662, 663],
      undefined,
      new Date(),
      20,
    );
    expect(arrivals).toEqual([]);
  });

  it("filters by route_id and sorts by time", async () => {
    const rt = fixtureTripUpdatesRtClient([
      {
        routeId: "1",
        stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: soon }],
      },
      {
        routeId: "900",
        stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: later }],
      },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals } = await predictedArrivals(
      db,
      updates,
      [662],
      "900",
      new Date(),
      20,
    );
    expect(arrivals.map((a) => a.route_id)).toEqual(["900"]);
  });

  it("caps at limit and reports truncated across station platforms", async () => {
    const rt = fixtureTripUpdatesRtClient([
      {
        routeId: "900",
        stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: soon }],
      },
      {
        routeId: "900",
        stopTimeUpdates: [{ stopId: "50663", arrivalSeconds: later }],
      },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals, truncated } = await predictedArrivals(
      db,
      updates,
      [662, 663],
      undefined,
      new Date(),
      1,
    );
    expect(arrivals).toHaveLength(1);
    expect(truncated).toBe(true);
  });
});
