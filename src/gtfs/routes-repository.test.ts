import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getRouteById, listRoutes } from "./routes-repository.js";
import { buildFixtureDb } from "./test-support.js";

describe("routes repository", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  describe("listRoutes", () => {
    it("returns every route in the catalog", async () => {
      const routes = await listRoutes(client);
      expect(routes.map((r) => r.route_id).sort()).toEqual(["1", "900"]);
    });

    it("filters by mode", async () => {
      const routes = await listRoutes(client, "subway");
      expect(routes).toEqual([
        {
          route_id: "1",
          route_short_name: "1",
          route_long_name: "Line 1 (Yonge-University)",
          mode: "subway",
          color: "D5C82B",
        },
      ]);
    });
  });

  describe("getRouteById", () => {
    it("returns a bus route with its direction and ordered stops", async () => {
      const route = await getRouteById(client, 900);
      expect(route).toMatchObject({
        route_id: "900",
        route_short_name: "900",
        mode: "bus",
      });
      expect(route?.directions).toEqual([
        { direction_id: 0, headsign: "Airport" },
      ]);
      expect(route?.stops_by_direction).toEqual([
        {
          direction_id: 0,
          stops: [
            expect.objectContaining({ stop_id: "662" }),
            expect.objectContaining({ stop_id: "663" }),
          ],
        },
      ]);
      expect(route?.truncated).toBe(false);
    });

    it("returns a subway route with a single-stop direction", async () => {
      const route = await getRouteById(client, 1);
      expect(route?.mode).toBe("subway");
      expect(route?.directions).toEqual([
        { direction_id: 0, headsign: "Finch" },
      ]);
      expect(route?.stops_by_direction).toEqual([
        {
          direction_id: 0,
          stops: [expect.objectContaining({ stop_id: "9001" })],
        },
      ]);
    });

    it("caps stops per direction and sets truncated", async () => {
      const route = await getRouteById(client, 900, {
        stopsPerDirectionLimit: 1,
      });
      expect(route?.stops_by_direction).toEqual([
        {
          direction_id: 0,
          stops: [expect.objectContaining({ stop_id: "662" })],
        },
      ]);
      expect(route?.truncated).toBe(true);
    });

    it("picks the trip with the most stops as the canonical trip per direction", async () => {
      // A short-turn variant on route 900's existing direction (0), with a
      // single stop — the two-stop trip from the fixture should still win.
      await client.execute({
        sql: `INSERT INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id, shape_id)
              VALUES (3, 900, 1, 'Short Turn', 0, NULL)`,
      });
      await client.execute({
        sql: `INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arr, dep)
              VALUES (3, 663, 1, 22200, 22200)`,
      });

      const route = await getRouteById(client, 900);
      expect(route?.stops_by_direction).toEqual([
        {
          direction_id: 0,
          stops: [
            expect.objectContaining({ stop_id: "662" }),
            expect.objectContaining({ stop_id: "663" }),
          ],
        },
      ]);
    });

    it("lists a second direction separately", async () => {
      await client.execute({
        sql: `INSERT INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id, shape_id)
              VALUES (4, 900, 1, 'Kennedy Station', 1, NULL)`,
      });
      await client.execute({
        sql: `INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arr, dep)
              VALUES (4, 663, 1, 22800, 22800), (4, 662, 2, 22900, 22900)`,
      });

      const route = await getRouteById(client, 900);
      expect(route?.directions).toEqual([
        { direction_id: 0, headsign: "Airport" },
        { direction_id: 1, headsign: "Kennedy Station" },
      ]);
      expect(route?.stops_by_direction).toEqual([
        {
          direction_id: 0,
          stops: [
            expect.objectContaining({ stop_id: "662" }),
            expect.objectContaining({ stop_id: "663" }),
          ],
        },
        {
          direction_id: 1,
          stops: [
            expect.objectContaining({ stop_id: "663" }),
            expect.objectContaining({ stop_id: "662" }),
          ],
        },
      ]);
    });

    it("returns undefined for an unknown route_id", async () => {
      await expect(getRouteById(client, 999999)).resolves.toBeUndefined();
    });
  });
});
