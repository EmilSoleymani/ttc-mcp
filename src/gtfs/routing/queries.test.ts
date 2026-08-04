import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRoutingFixtureDb } from "../test-support.js";
import {
  fetchBoardings,
  fetchDownstream,
  fetchFootpaths,
  fetchRouteMeta,
} from "./queries.js";

// GTFS service seconds for the fixture times.
const T = {
  "8:00": 28800,
  "8:05": 29100,
  "8:10": 29400,
  "8:20": 30000,
  "8:22": 30120,
  "8:30": 30600,
} as const;

describe("routing queries", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildRoutingFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  describe("fetchFootpaths", () => {
    it("returns the seeded street interchange", async () => {
      expect(await fetchFootpaths(client, [103])).toEqual([
        {
          from_stop_id: 103,
          to_stop_id: 201,
          min_walk_seconds: 90,
          type: "street",
        },
      ]);
    });
    it("is empty for a stop with no footpaths", async () => {
      expect(await fetchFootpaths(client, [999])).toEqual([]);
    });
    it("is empty for no stops", async () => {
      expect(await fetchFootpaths(client, [])).toEqual([]);
    });
  });

  describe("fetchBoardings", () => {
    it("picks the earliest trip per pattern from a marked stop", async () => {
      const rows = await fetchBoardings(
        client,
        [{ stop_id: 101, min_dep: 0 }],
        [1],
      );
      expect(rows).toEqual([
        {
          stop_id: 101,
          route_id: 10,
          direction_id: 0,
          headsign: "Aend",
          dep: T["8:00"],
          trip_id: 100,
        },
      ]);
    });

    it("respects a per-stop threshold above the earliest trip", async () => {
      const rows = await fetchBoardings(
        client,
        [{ stop_id: 101, min_dep: T["8:00"] + 1 }],
        [1],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ trip_id: 101, dep: T["8:30"] });
    });

    it("returns both headsign branches as distinct patterns", async () => {
      const rows = await fetchBoardings(
        client,
        [{ stop_id: 202, min_dep: 0 }],
        [1],
      );
      const byHeadsign = Object.fromEntries(rows.map((r) => [r.headsign, r]));
      expect(Object.keys(byHeadsign).sort()).toEqual([
        "Broadview Junction",
        "Broadview Station",
      ]);
      expect(byHeadsign["Broadview Station"]).toMatchObject({
        trip_id: 110,
        dep: T["8:20"],
      });
      expect(byHeadsign["Broadview Junction"]).toMatchObject({
        trip_id: 111,
        dep: T["8:22"],
      });
    });

    it("applies the mode filter (subway excludes a bus route)", async () => {
      expect(
        await fetchBoardings(
          client,
          [{ stop_id: 201, min_dep: 0 }],
          [1],
          ["subway"],
        ),
      ).toEqual([]);
      const busRows = await fetchBoardings(
        client,
        [{ stop_id: 201, min_dep: 0 }],
        [1],
        ["bus"],
      );
      expect(busRows.length).toBeGreaterThan(0);
    });

    it("is empty when there is no marked set or no active service", async () => {
      expect(await fetchBoardings(client, [], [1])).toEqual([]);
      expect(
        await fetchBoardings(client, [{ stop_id: 101, min_dep: 0 }], []),
      ).toEqual([]);
    });
  });

  describe("fetchDownstream", () => {
    it("returns downstream stops of a boarded trip in sequence", async () => {
      const rows = await fetchDownstream(client, [100]);
      expect(rows).toEqual([
        {
          trip_id: 100,
          stop_id: 101,
          stop_sequence: 1,
          arr: T["8:00"],
          dep: T["8:00"],
        },
        {
          trip_id: 100,
          stop_id: 102,
          stop_sequence: 2,
          arr: T["8:05"],
          dep: T["8:05"],
        },
        {
          trip_id: 100,
          stop_id: 103,
          stop_sequence: 3,
          arr: T["8:10"],
          dep: T["8:10"],
        },
      ]);
    });
    it("is empty for no trips", async () => {
      expect(await fetchDownstream(client, [])).toEqual([]);
    });
  });

  describe("fetchRouteMeta", () => {
    it("returns short name and derived mode per route", async () => {
      const meta = await fetchRouteMeta(client, [10, 20]);
      expect(meta.get(10)).toEqual({ route_short_name: "10", mode: "subway" });
      expect(meta.get(20)).toEqual({ route_short_name: "20", mode: "bus" });
    });
    it("is empty for no routes", async () => {
      expect((await fetchRouteMeta(client, [])).size).toBe(0);
    });
  });
});
