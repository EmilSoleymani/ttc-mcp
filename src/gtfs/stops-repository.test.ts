import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getStopById,
  listStops,
  searchStopsByName,
  searchStopsNear,
} from "./stops-repository.js";
import { buildFixtureDb } from "./test-support.js";

describe("stops repository", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  describe("searchStopsByName", () => {
    it("finds a bus stop by (partial, case-insensitive) name", async () => {
      const { stops, truncated } = await searchStopsByName(client, "danforth");
      expect(truncated).toBe(false);
      expect(stops).toEqual([
        {
          stop_id: "662",
          stop_code: "662",
          name: "Danforth Rd at Kennedy Rd",
          mode: "bus",
          is_station: false,
          lat: 43.714379,
          lon: -79.260939,
        },
      ]);
    });

    it("excludes stops with no scheduled service (e.g. a bare entrance node)", async () => {
      const { stops } = await searchStopsByName(client, "Entrance");
      expect(stops).toEqual([]);
    });

    it("filters by mode", async () => {
      const { stops } = await searchStopsByName(client, "Union", {
        mode: "bus",
      });
      expect(stops).toEqual([]);
    });

    it("caps results and sets truncated", async () => {
      const { stops, truncated } = await searchStopsByName(client, "Station", {
        limit: 1,
      });
      expect(stops).toHaveLength(1);
      expect(truncated).toBe(true);
    });
  });

  describe("searchStopsNear", () => {
    it("finds only the origin stop within a tight radius", async () => {
      const { stops } = await searchStopsNear(
        client,
        43.714379,
        -79.260939,
        500,
      );
      expect(stops.map((s) => s.stop_id)).toEqual(["662"]);
    });

    it("finds both stops within a wider radius, nearest first", async () => {
      const { stops } = await searchStopsNear(
        client,
        43.714379,
        -79.260939,
        5000,
      );
      expect(stops.map((s) => s.stop_id)).toEqual(["662", "663"]);
    });

    it("returns both the station and its platform near Union", async () => {
      const { stops } = await searchStopsNear(
        client,
        43.645286,
        -79.380875,
        200,
      );
      const byId = new Map(stops.map((s) => [s.stop_id, s]));
      expect(byId.get("9000")).toMatchObject({
        mode: "subway",
        is_station: true,
      });
      expect(byId.get("9001")).toMatchObject({
        mode: "subway",
        is_station: false,
      });
    });
  });

  describe("getStopById", () => {
    it("aggregates a station's mode and routes from its platform", async () => {
      const stop = await getStopById(client, 9000);
      expect(stop).toMatchObject({
        stop_id: "9000",
        name: "Union Station",
        mode: "subway",
        is_station: true,
      });
      expect(stop?.platforms).toEqual([
        {
          stop_id: "9001",
          name: "Union Station - Platform 1",
          mode: "subway",
          is_station: false,
          parent_station: "9000",
          lat: 43.6453,
          lon: -79.3809,
        },
      ]);
      expect(stop?.routes).toEqual([
        {
          route_id: "1",
          route_short_name: "1",
          route_long_name: "Line 1 (Yonge-University)",
          mode: "subway",
          color: "D5C82B",
        },
      ]);
    });

    it("returns a surface stop with its route, no platforms field", async () => {
      const stop = await getStopById(client, 662);
      expect(stop?.platforms).toBeUndefined();
      expect(stop?.routes).toEqual([
        {
          route_id: "900",
          route_short_name: "900",
          route_long_name: "Airport Express",
          mode: "bus",
        },
      ]);
    });

    it("returns undefined for an id with no scheduled service", async () => {
      await expect(getStopById(client, 9002)).resolves.toBeUndefined();
    });

    it("returns undefined for an unknown id", async () => {
      await expect(getStopById(client, 999999)).resolves.toBeUndefined();
    });
  });

  describe("listStops", () => {
    it("returns every stop with resolvable mode, excluding unserved rows", async () => {
      const stops = await listStops(client);
      const ids = stops.map((s) => s.stop_id).sort();
      expect(ids).toEqual(["662", "663", "9000", "9001"]);
      expect(stops.find((s) => s.stop_id === "9000")?.mode).toBe("subway");
    });
  });
});
