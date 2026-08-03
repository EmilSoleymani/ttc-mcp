import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFixtureDb } from "./test-support.js";
import {
  countStaticTrips,
  getStaticTripById,
  parseRtTripId,
  staticTripIdsExisting,
} from "./trips-repository.js";

describe("parseRtTripId", () => {
  it("parses a numeric RT trip_id string the same way ingest parsed the static PK", () => {
    expect(parseRtTripId("47483136")).toBe(47483136);
    // Leading zeros collapse identically on both sides (Number("007") === 7),
    // which is exactly why the join is well-defined.
    expect(parseRtTripId("007")).toBe(7);
  });

  it("returns null for a non-numeric or empty trip_id (→ never-drop fallback)", () => {
    expect(parseRtTripId("abc-123")).toBeNull();
    expect(parseRtTripId("")).toBeNull();
    expect(parseRtTripId(null)).toBeNull();
    expect(parseRtTripId(undefined)).toBeNull();
  });
});

describe("static trips repository", () => {
  let db: Client;
  beforeAll(async () => {
    db = await buildFixtureDb();
  });
  afterAll(() => {
    db.close();
  });

  it("counts the ingested trips", async () => {
    expect(await countStaticTrips(db)).toBe(2);
  });

  it("looks up a trip by id, joined to its route for route_short_name", async () => {
    expect(await getStaticTripById(db, 1)).toEqual({
      trip_id: 1,
      route_id: 1,
      route_short_name: "1",
      headsign: "Finch",
      direction_id: 0,
    });
  });

  it("returns undefined for a trip_id absent from the static feed", async () => {
    expect(await getStaticTripById(db, 99999999)).toBeUndefined();
  });

  it("resolves the subset of ids present in static, ignoring absent ones", async () => {
    const present = await staticTripIdsExisting(db, [1, 2, 99999999]);
    expect(present).toEqual(new Set([1, 2]));
  });
});
