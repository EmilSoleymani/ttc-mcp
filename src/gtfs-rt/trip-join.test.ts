import { describe, expect, it } from "vitest";

import type { StaticTrip } from "../gtfs/trips-repository.js";
import { resolveArrivalIdentity } from "./trip-join.js";

const STATIC_TRIP: StaticTrip = {
  trip_id: 47483136,
  route_id: 504,
  route_short_name: "504",
  headsign: "King via Roncesvalles",
  direction_id: 1,
};

describe("resolveArrivalIdentity — matched trip_id", () => {
  it("enriches from the static trip when the trip_id joined", () => {
    const identity = resolveArrivalIdentity(
      { tripId: "47483136", routeId: "504", headsign: "IGNORED RT HEADSIGN" },
      STATIC_TRIP,
    );
    expect(identity).toEqual({
      route_id: "504",
      route_short_name: "504",
      headsign: "King via Roncesvalles",
      direction_id: 1,
      matched: true,
    });
  });

  it("falls back to the RT headsign when the static headsign is blank", () => {
    const identity = resolveArrivalIdentity(
      { tripId: "1", routeId: "504", headsign: "King" },
      { trip_id: 1, route_id: 504, route_short_name: "504" },
    );
    expect(identity?.headsign).toBe("King");
    expect(identity?.matched).toBe(true);
  });

  it("defaults a missing static direction_id to 0", () => {
    const identity = resolveArrivalIdentity(
      { tripId: "1", routeId: "504" },
      { trip_id: 1, route_id: 504 },
    );
    expect(identity?.direction_id).toBe(0);
    expect(identity?.headsign).toBe("");
  });
});

describe("resolveArrivalIdentity — never-drop fallback", () => {
  it("keeps an unmatched trip_id, surfacing the RT route_id + headsign", () => {
    const identity = resolveArrivalIdentity(
      { tripId: "99999999", routeId: "504", headsign: "King" },
      undefined, // trip_id did not join to any static trip
    );
    expect(identity).toEqual({
      route_id: "504",
      headsign: "King",
      direction_id: 0,
      matched: false,
    });
  });

  it("keeps a non-numeric trip_id (which can never match a numeric PK)", () => {
    const identity = resolveArrivalIdentity(
      { tripId: "abc-123", routeId: "512" },
      undefined,
    );
    expect(identity?.route_id).toBe("512");
    expect(identity?.matched).toBe(false);
  });

  it("keeps an update with no trip_id at all, as long as it has a route_id", () => {
    const identity = resolveArrivalIdentity({ routeId: "29" }, undefined);
    expect(identity?.route_id).toBe("29");
    expect(identity?.matched).toBe(false);
  });

  it("only drops when there is no usable route at all (RT deadhead analogue)", () => {
    expect(
      resolveArrivalIdentity({ tripId: "99999999" }, undefined),
    ).toBeUndefined();
    expect(
      resolveArrivalIdentity({ tripId: "99999999", routeId: "" }, undefined),
    ).toBeUndefined();
  });
});
