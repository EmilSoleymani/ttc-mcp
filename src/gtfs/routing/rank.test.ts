import { describe, expect, it } from "vitest";

import type { Itinerary, Leg } from "../../schemas/itinerary.js";
import type { StopSummary } from "../../schemas/stop.js";
import {
  dedupeBySignature,
  routeSignature,
  sortByArrival,
  sortByLatestDeparture,
} from "./rank.js";

const stop: StopSummary = {
  stop_id: "1",
  name: "S",
  mode: "bus",
  is_station: false,
  lat: 43.6,
  lon: -79.4,
};

function transit(routeId: string): Leg {
  return {
    type: "transit",
    mode: "bus",
    route_id: routeId,
    headsign: "X",
    board: stop,
    alight: stop,
    board_time: "2026-08-04T08:00:00-04:00",
    alight_time: "2026-08-04T08:10:00-04:00",
    num_stops: 2,
  };
}

function itin(routeIds: string[], depart: string, arrive: string): Itinerary {
  return {
    depart_time: depart,
    arrive_time: arrive,
    duration_seconds:
      (new Date(arrive).getTime() - new Date(depart).getTime()) / 1000,
    transfers: routeIds.length - 1,
    legs: routeIds.map(transit),
  };
}

describe("rank helpers", () => {
  it("routeSignature is the ordered transit route_ids", () => {
    expect(
      routeSignature(
        itin(
          ["1", "2"],
          "2026-08-04T08:00:00-04:00",
          "2026-08-04T08:30:00-04:00",
        ),
      ),
    ).toBe("1>2");
  });

  it("dedupeBySignature keeps the first of each signature, in order", () => {
    const a = itin(
      ["1"],
      "2026-08-04T08:00:00-04:00",
      "2026-08-04T08:20:00-04:00",
    );
    const b = itin(
      ["1"],
      "2026-08-04T08:10:00-04:00",
      "2026-08-04T08:30:00-04:00",
    ); // same route, later
    const c = itin(
      ["2"],
      "2026-08-04T08:05:00-04:00",
      "2026-08-04T08:25:00-04:00",
    );
    const out = dedupeBySignature([a, b, c]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(c);
  });

  it("sortByArrival orders by earliest arrival", () => {
    const late = itin(
      ["1"],
      "2026-08-04T08:00:00-04:00",
      "2026-08-04T09:00:00-04:00",
    );
    const early = itin(
      ["2"],
      "2026-08-04T08:30:00-04:00",
      "2026-08-04T08:45:00-04:00",
    );
    expect(sortByArrival([late, early]).map((i) => i.arrive_time)).toEqual([
      "2026-08-04T08:45:00-04:00",
      "2026-08-04T09:00:00-04:00",
    ]);
  });

  it("sortByArrival breaks arrival ties by shorter duration", () => {
    // Same arrival; the one that departs later (shorter ride) ranks first.
    const longRide = itin(
      ["1"],
      "2026-08-04T08:00:00-04:00",
      "2026-08-04T09:00:00-04:00",
    ); // 60 min
    const shortRide = itin(
      ["2"],
      "2026-08-04T08:30:00-04:00",
      "2026-08-04T09:00:00-04:00",
    ); // 30 min
    expect(
      sortByArrival([longRide, shortRide]).map((i) => i.duration_seconds),
    ).toEqual([1800, 3600]);
  });

  it("sortByLatestDeparture orders by latest departure", () => {
    const earlyDep = itin(
      ["1"],
      "2026-08-04T08:00:00-04:00",
      "2026-08-04T08:40:00-04:00",
    );
    const lateDep = itin(
      ["2"],
      "2026-08-04T08:25:00-04:00",
      "2026-08-04T08:55:00-04:00",
    );
    expect(
      sortByLatestDeparture([earlyDep, lateDep]).map((i) => i.depart_time),
    ).toEqual(["2026-08-04T08:25:00-04:00", "2026-08-04T08:00:00-04:00"]);
  });

  it("sortByLatestDeparture breaks departure ties by shorter duration", () => {
    // Same departure; the one that arrives sooner (shorter ride) ranks first.
    const longRide = itin(
      ["1"],
      "2026-08-04T08:00:00-04:00",
      "2026-08-04T09:00:00-04:00",
    ); // 60 min
    const shortRide = itin(
      ["2"],
      "2026-08-04T08:00:00-04:00",
      "2026-08-04T08:30:00-04:00",
    ); // 30 min
    expect(
      sortByLatestDeparture([longRide, shortRide]).map(
        (i) => i.duration_seconds,
      ),
    ).toEqual([1800, 3600]);
  });
});
