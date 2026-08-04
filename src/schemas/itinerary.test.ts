import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  candidatesSchema,
  itinerarySchema,
  legSchema,
  planTripInputShape,
  planTripOutputShape,
} from "./itinerary.js";

const stopSummary = {
  stop_id: "401",
  name: "Union Station",
  mode: "subway" as const,
  is_station: true,
  lat: 43.645,
  lon: -79.38,
};

const transitLeg = {
  type: "transit" as const,
  mode: "subway" as const,
  route_id: "1",
  route_short_name: "1",
  headsign: "Finch",
  board: stopSummary,
  alight: { ...stopSummary, stop_id: "402", name: "King" },
  board_time: "2026-08-04T10:00:00-04:00",
  alight_time: "2026-08-04T10:03:00-04:00",
  num_stops: 1,
};

const transferLeg = {
  type: "transfer" as const,
  from: stopSummary,
  to: { ...stopSummary, stop_id: "402", name: "King" },
  walk_seconds: 120,
};

describe("itinerary schemas", () => {
  it("parses a transit leg and a transfer leg via the discriminated union", () => {
    expect(legSchema.parse(transitLeg)).toMatchObject({ type: "transit" });
    expect(legSchema.parse(transferLeg)).toMatchObject({ type: "transfer" });
  });

  it("rejects a transit leg missing board", () => {
    const noBoard: Record<string, unknown> = { ...transitLeg };
    delete noBoard.board;
    expect(legSchema.safeParse(noBoard).success).toBe(false);
  });

  it("parses a full itinerary", () => {
    const itinerary = {
      depart_time: "2026-08-04T10:00:00-04:00",
      arrive_time: "2026-08-04T10:03:00-04:00",
      duration_seconds: 180,
      transfers: 0,
      legs: [transitLeg],
    };
    expect(itinerarySchema.parse(itinerary).legs).toHaveLength(1);
  });

  it("accepts an ambiguous-shaped output (from null + candidates, empty itineraries)", () => {
    const output = z.object(planTripOutputShape);
    const parsed = output.parse({
      from: null,
      to: stopSummary,
      itineraries: [],
      candidates: { endpoint: "from", matches: [stopSummary] },
    });
    expect(parsed.candidates?.endpoint).toBe("from");
    expect(parsed.from).toBeNull();
  });

  it("candidatesSchema requires endpoint from|to", () => {
    expect(
      candidatesSchema.safeParse({ endpoint: "middle", matches: [] }).success,
    ).toBe(false);
  });

  it("input shape accepts a string endpoint and a lat/lon endpoint", () => {
    const input = z.object(planTripInputShape);
    expect(input.parse({ from: "Union", to: "King" }).from).toBe("Union");
    expect(
      input.parse({ from: { lat: 43.6, lon: -79.4 }, to: "King" }).from,
    ).toMatchObject({ lat: 43.6 });
  });

  it("input shape caps max_transfers at 3", () => {
    const input = z.object(planTripInputShape);
    expect(
      input.safeParse({ from: "a", to: "b", max_transfers: 4 }).success,
    ).toBe(false);
    expect(
      input.safeParse({ from: "a", to: "b", max_transfers: 3 }).success,
    ).toBe(true);
  });
});
