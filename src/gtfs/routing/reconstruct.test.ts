import { describe, expect, it } from "vitest";

import type { Leg } from "../../schemas/itinerary.js";
import type { StopSummary } from "../../schemas/stop.js";
import { mergeConsecutiveTransferLegs } from "./reconstruct.js";

function stop(id: string): StopSummary {
  return {
    stop_id: id,
    name: `Stop ${id}`,
    mode: "bus",
    is_station: false,
    lat: 43.6,
    lon: -79.4,
  };
}

function transfer(from: string, to: string, walk: number): Leg {
  return {
    type: "transfer",
    from: stop(from),
    to: stop(to),
    walk_seconds: walk,
  };
}

function transit(board: string, alight: string): Leg {
  return {
    type: "transit",
    mode: "bus",
    route_id: "1",
    headsign: "X",
    board: stop(board),
    alight: stop(alight),
    board_time: "2026-08-04T08:00:00-04:00",
    alight_time: "2026-08-04T08:10:00-04:00",
    num_stops: 3,
  };
}

describe("mergeConsecutiveTransferLegs", () => {
  it("merges a trailing interchange+egress into one direct walk, summing seconds", () => {
    const legs = [
      transit("A", "B"),
      transfer("B", "C", 191),
      transfer("C", "D", 190),
    ];
    const merged = mergeConsecutiveTransferLegs(legs);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual({
      type: "transfer",
      from: stop("B"),
      to: stop("D"),
      walk_seconds: 381,
    });
  });

  it("merges a run of three transfers", () => {
    const legs = [
      transfer("A", "B", 10),
      transfer("B", "C", 20),
      transfer("C", "D", 30),
      transit("D", "E"),
    ];
    const merged = mergeConsecutiveTransferLegs(legs);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      from: stop("A"),
      to: stop("D"),
      walk_seconds: 60,
    });
  });

  it("leaves an already-alternating itinerary untouched", () => {
    const legs = [transit("A", "B"), transfer("B", "C", 90), transit("C", "D")];
    expect(mergeConsecutiveTransferLegs(legs)).toEqual(legs);
  });

  it("drops a merged zero-length walk (from === to)", () => {
    const legs = [
      transit("A", "B"),
      transfer("B", "C", 60),
      transfer("C", "B", 60),
    ];
    const merged = mergeConsecutiveTransferLegs(legs);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.type).toBe("transit");
  });
});
