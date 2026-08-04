import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureDb } from "../gtfs/test-support.js";
import { predictedArrivals } from "./arrivals-repository.js";
import { fixtureTripUpdatesRtClient } from "./test-support.js";

// Fixture routes/stops come from buildFixtureDb: route 900 (bus) serves
// stops 662 and 663. We add crosswalk rows mapping RT stop ids 50662->662
// and 50663->663 (the Dataset-B-namespace ids the RT feed would carry).
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

  it("returns a predicted arrival for a crosswalked stop, route enriched, unmatched trip -> headsign '' dir 0", async () => {
    const rt = fixtureTripUpdatesRtClient([
      {
        routeId: "900",
        tripId: "999999",
        stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: soon }],
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
    expect(arrivals[0]).toMatchObject({
      route_id: "900",
      route_short_name: "900",
      headsign: "",
      direction_id: 0,
      realtime: true,
      source: "predicted",
    });
    expect(arrivals[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(arrivals[0]!.delay_seconds).toBeUndefined();
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
