import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Itinerary } from "../../schemas/itinerary.js";
import { buildRoutingFixtureDb } from "../test-support.js";
import { planDepartAfter, resolveBothEndpoints } from "./index.js";

// Resolve two endpoints and plan a depart-after trip, the way the tool will.
async function plan(
  client: Client,
  from: string,
  to: string,
  when: string,
  opts: {
    maxTransfers?: number;
    modes?: ("subway" | "streetcar" | "bus")[];
  } = {},
): Promise<Itinerary | undefined> {
  const both = await resolveBothEndpoints(client, from, to);
  if (both.kind !== "ok")
    throw new Error(`expected ok resolution, got ${both.kind}`);
  return planDepartAfter(client, {
    from: both.from,
    to: both.to,
    fromAccess: both.fromAccess,
    toAccess: both.toAccess,
    depart: new Date(when),
    maxTransfers: opts.maxTransfers ?? 3,
    ...(opts.modes !== undefined ? { modes: opts.modes } : {}),
  });
}

describe("planDepartAfter", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildRoutingFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  it("plans a single-leg subway trip", async () => {
    const itin = await plan(client, "101", "103", "2026-08-04T08:00:00-04:00");
    expect(itin).toBeDefined();
    expect(itin?.transfers).toBe(0);
    expect(itin?.depart_time).toBe("2026-08-04T08:00:00-04:00");
    expect(itin?.arrive_time).toBe("2026-08-04T08:10:00-04:00");
    expect(itin?.duration_seconds).toBe(600);
    expect(itin?.legs).toHaveLength(1);
    expect(itin?.legs[0]).toMatchObject({
      type: "transit",
      mode: "subway",
      route_id: "10",
      route_short_name: "10",
      num_stops: 2,
      board: { stop_id: "101" },
      alight: { stop_id: "103" },
      board_time: "2026-08-04T08:00:00-04:00",
      alight_time: "2026-08-04T08:10:00-04:00",
    });
  });

  it("plans a two-seat multimodal ride with a street transfer", async () => {
    const itin = await plan(client, "101", "203", "2026-08-04T08:00:00-04:00");
    expect(itin).toBeDefined();
    expect(itin?.transfers).toBe(1);
    expect(itin?.arrive_time).toBe("2026-08-04T08:30:00-04:00");
    expect(itin?.legs.map((l) => l.type)).toEqual([
      "transit",
      "transfer",
      "transit",
    ]);

    const [subway, transfer, bus] = itin!.legs;
    expect(subway).toMatchObject({
      type: "transit",
      mode: "subway",
      route_id: "10",
    });
    expect(transfer).toMatchObject({
      type: "transfer",
      from: { stop_id: "103" },
      to: { stop_id: "201" },
      walk_seconds: 90,
    });
    expect(bus).toMatchObject({
      type: "transit",
      mode: "bus",
      route_id: "20",
      board: { stop_id: "201" },
      alight: { stop_id: "203" },
      board_time: "2026-08-04T08:15:00-04:00",
      alight_time: "2026-08-04T08:30:00-04:00",
    });
  });

  it("respects depart-after by catching the next departure", async () => {
    const itin = await plan(client, "101", "103", "2026-08-04T08:01:00-04:00");
    expect(itin?.depart_time).toBe("2026-08-04T08:30:00-04:00");
    expect(itin?.arrive_time).toBe("2026-08-04T08:40:00-04:00");
  });

  it("returns no itinerary when a modes filter blocks the only path", async () => {
    const itin = await plan(client, "101", "203", "2026-08-04T08:00:00-04:00", {
      modes: ["subway"],
    });
    expect(itin).toBeUndefined();
  });

  it("returns no itinerary when the destination is unreachable", async () => {
    // The fixture routes run in one direction only; 203 -> 101 has no service.
    const itin = await plan(client, "203", "101", "2026-08-04T08:00:00-04:00");
    expect(itin).toBeUndefined();
  });
});
