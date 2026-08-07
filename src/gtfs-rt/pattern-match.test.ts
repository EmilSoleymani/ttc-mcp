import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRoutingFixtureDb } from "../gtfs/test-support.js";
import {
  lcsLength,
  loadRoutePatterns,
  matchPattern,
  type RoutePattern,
} from "./pattern-match.js";

describe("lcsLength", () => {
  it("is the length of the longest order-preserving common subsequence", () => {
    expect(lcsLength([1, 2, 3], [1, 2, 3])).toBe(3);
    expect(lcsLength([1, 2, 3, 4, 5], [2, 4])).toBe(2);
    // Order matters: the reverse shares only a single element in order.
    expect(lcsLength([1, 2, 3], [3, 2, 1])).toBe(1);
    expect(lcsLength([], [1, 2])).toBe(0);
    expect(lcsLength([1, 2], [])).toBe(0);
  });
});

describe("loadRoutePatterns", () => {
  let db: Client;
  beforeEach(async () => {
    db = await buildRoutingFixtureDb();
  });
  afterEach(() => {
    db.close();
  });

  it("collapses a route's trips to its distinct stop-sequence patterns", async () => {
    // Route 10 has three trips (100/101/102), all the same stop sequence.
    const patterns = await loadRoutePatterns(db, "10");
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toEqual({
      headsign: "Aend",
      direction_id: 0,
      stopIds: [101, 102, 103],
    });
  });

  it("keeps a route's branches as separate patterns", async () => {
    // Route 20 splits after 202 into two headsigns (110→203, 111→204).
    const patterns = await loadRoutePatterns(db, "20");
    expect(patterns).toHaveLength(2);
    const byHeadsign = new Map(patterns.map((p) => [p.headsign, p.stopIds]));
    expect(byHeadsign.get("Broadview Station")).toEqual([201, 202, 203]);
    expect(byHeadsign.get("Broadview Junction")).toEqual([201, 202, 204]);
  });

  it("returns nothing for an unknown or non-numeric route", async () => {
    expect(await loadRoutePatterns(db, "9999")).toEqual([]);
    expect(await loadRoutePatterns(db, "notaroute")).toEqual([]);
  });
});

describe("matchPattern", () => {
  const north: RoutePattern = {
    headsign: "Northbound",
    direction_id: 0,
    stopIds: [1, 2, 3, 4, 5],
  };
  const south: RoutePattern = {
    headsign: "Southbound",
    direction_id: 1,
    stopIds: [5, 4, 3, 2, 1],
  };

  it("recovers direction from stop order (a tail of the outbound pattern)", () => {
    const match = matchPattern([3, 4, 5], [north, south], 4);
    expect(match).toEqual({ headsign: "Northbound", direction_id: 0 });
  });

  it("recovers the opposite direction for the reversed stop order", () => {
    const match = matchPattern([3, 2, 1], [north, south], 2);
    expect(match).toEqual({ headsign: "Southbound", direction_id: 1 });
  });

  it("returns null when two directions are within the ambiguity margin", () => {
    // A single shared stop is a length-1 subsequence of BOTH patterns → tie.
    expect(matchPattern([3], [north, south], 3)).toBeNull();
  });

  it("only considers patterns that actually serve the queried stop", () => {
    const stationBranch: RoutePattern = {
      headsign: "Station",
      direction_id: 0,
      stopIds: [201, 202, 203],
    };
    const junctionBranch: RoutePattern = {
      headsign: "Junction",
      direction_id: 0,
      stopIds: [201, 202, 204],
    };
    // Querying 203 excludes the junction branch (which doesn't serve it), so
    // the live trip resolves unambiguously to the station branch.
    const match = matchPattern(
      [201, 202, 203],
      [stationBranch, junctionBranch],
      203,
    );
    expect(match).toEqual({ headsign: "Station", direction_id: 0 });
  });

  it("returns null on the shared trunk where the branch is undecided", () => {
    const stationBranch: RoutePattern = {
      headsign: "Station",
      direction_id: 0,
      stopIds: [201, 202, 203],
    };
    const junctionBranch: RoutePattern = {
      headsign: "Junction",
      direction_id: 0,
      stopIds: [201, 202, 204],
    };
    // Only trunk stops seen → both branches tie → decline to guess.
    expect(
      matchPattern([201, 202], [stationBranch, junctionBranch], 202),
    ).toBeNull();
  });

  it("returns null below the coverage threshold", () => {
    // Two of three RT stops aren't on the pattern → coverage 1/3 < 0.6.
    expect(matchPattern([2, 90, 91], [north], 2)).toBeNull();
  });

  it("returns null for an empty stop list or no candidate patterns", () => {
    expect(matchPattern([], [north], 1)).toBeNull();
    expect(matchPattern([1, 2, 3], [], 1)).toBeNull();
  });
});
