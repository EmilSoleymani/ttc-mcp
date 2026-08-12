import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Endpoint, Itinerary } from "../../schemas/itinerary.js";
import { buildRoutingFixtureDb } from "../test-support.js";
import { planDepartAfter, planTrip, resolveBothEndpoints } from "./index.js";

// Resolve two endpoints and plan a depart-after trip, the way the tool will.
async function plan(
  client: Client,
  from: Endpoint,
  to: Endpoint,
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

  it("plans a streetcar leg end-to-end", async () => {
    const itin = await plan(client, "301", "303", "2026-08-04T09:00:00-04:00");
    expect(itin).toBeDefined();
    expect(itin?.transfers).toBe(0);
    expect(itin?.legs).toHaveLength(1);
    expect(itin?.legs[0]).toMatchObject({
      type: "transit",
      mode: "streetcar",
      route_id: "30",
      board: { stop_id: "301" },
      alight: { stop_id: "303" },
      num_stops: 2,
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

  it("plans across midnight via the D-1 service-day carryover", async () => {
    // The fixture's route-10 past-midnight trip departs 101 at 25:00 (= 01:00
    // the next calendar day) on the prior service day. A plan leaving at 00:10
    // must find it via the D-1 window, not wait for the 08:00 same-day trip.
    const itin = await plan(client, "101", "103", "2026-08-05T00:10:00-04:00");
    expect(itin).toBeDefined();
    expect(itin?.depart_time).toBe("2026-08-05T01:00:00-04:00");
    expect(itin?.arrive_time).toBe("2026-08-05T01:10:00-04:00");
  });

  it("plans from a lat/lon origin, snapping to a nearby stop", async () => {
    // ~10 m north of stop 101 (43.65, -79.38): resolves `from` to stop 101 and
    // boards there (the sub-10 s snap walk is folded into the reported origin,
    // not shown as a leg — v1 snaps to nearby stops).
    const from = { lat: 43.6501, lon: -79.38 };
    const both = await resolveBothEndpoints(client, from, "103");
    if (both.kind !== "ok") throw new Error(`expected ok, got ${both.kind}`);
    expect(both.from.stop_id).toBe("101");

    const itin = await planDepartAfter(client, {
      from: both.from,
      to: both.to,
      fromAccess: both.fromAccess,
      toAccess: both.toAccess,
      depart: new Date("2026-08-04T08:00:00-04:00"),
      maxTransfers: 3,
    });
    expect(itin).toBeDefined();
    const firstTransit = itin?.legs.find((l) => l.type === "transit");
    expect(firstTransit).toMatchObject({ board: { stop_id: "101" } });
  });

  it("returns no itinerary for from === to", async () => {
    const itin = await plan(client, "101", "101", "2026-08-04T08:00:00-04:00");
    expect(itin).toBeUndefined();
  });

  it("returns no itinerary when the next service is beyond the search horizon", async () => {
    // At 01:30 the next route-10 trip is 08:00 (6.5 h out), past the 6 h
    // horizon; the overnight 25:00 trip has already departed.
    const itin = await plan(client, "101", "103", "2026-08-04T01:30:00-04:00");
    expect(itin).toBeUndefined();
  });
});

describe("planTrip (alternates)", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildRoutingFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  async function planMany(
    from: Endpoint,
    to: Endpoint,
    when: string,
    maxItineraries: number,
  ): Promise<Itinerary[]> {
    const both = await resolveBothEndpoints(client, from, to);
    if (both.kind !== "ok") throw new Error(`expected ok, got ${both.kind}`);
    return planTrip(client, {
      from: both.from,
      to: both.to,
      fromAccess: both.fromAccess,
      toAccess: both.toAccess,
      when: new Date(when),
      arriveBy: false,
      maxTransfers: 3,
      maxItineraries,
    });
  }

  it("returns two distinct-route alternates, earliest arrival first", async () => {
    const itins = await planMany("401", "402", "2026-08-04T10:00:00-04:00", 3);
    expect(itins).toHaveLength(2);
    expect(
      itins.map((i) => i.legs[0]?.type === "transit" && i.legs[0].route_id),
    ).toEqual(["40", "41"]);
    expect(itins.map((i) => i.arrive_time)).toEqual([
      "2026-08-04T10:10:00-04:00",
      "2026-08-04T10:15:00-04:00",
    ]);
  });

  it("caps at max_itineraries", async () => {
    const itins = await planMany("401", "402", "2026-08-04T10:00:00-04:00", 1);
    expect(itins).toHaveLength(1);
    expect(itins[0]?.legs[0]).toMatchObject({ route_id: "40" });
  });

  it("does not invent duplicate options when only one route serves the pair", async () => {
    const itins = await planMany("101", "103", "2026-08-04T08:00:00-04:00", 3);
    expect(itins).toHaveLength(1);
  });

  it("returns [] when unreachable", async () => {
    const itins = await planMany("203", "101", "2026-08-04T08:00:00-04:00", 3);
    expect(itins).toEqual([]);
  });
});

describe("planTrip (arrive_by, emulated)", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildRoutingFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  async function arriveBy(
    from: Endpoint,
    to: Endpoint,
    when: string,
    maxItineraries: number,
  ): Promise<Itinerary[]> {
    const both = await resolveBothEndpoints(client, from, to);
    if (both.kind !== "ok") throw new Error(`expected ok, got ${both.kind}`);
    return planTrip(client, {
      from: both.from,
      to: both.to,
      fromAccess: both.fromAccess,
      toAccess: both.toAccess,
      when: new Date(when),
      arriveBy: true,
      maxTransfers: 3,
      maxItineraries,
    });
  }

  it("picks the latest departure that still arrives by the target", async () => {
    // route 10 runs 101->103 at 08:00 (arr 08:10) and 08:30 (arr 08:40).
    // Arriving by 08:45, the latest catchable departure is the 08:30 trip.
    const itins = await arriveBy("101", "103", "2026-08-04T08:45:00-04:00", 3);
    expect(itins).toHaveLength(1);
    expect(itins[0]?.depart_time).toBe("2026-08-04T08:30:00-04:00");
    expect(itins[0]?.arrive_time).toBe("2026-08-04T08:40:00-04:00");
  });

  it("ranks distinct-route options by latest departure", async () => {
    // Both routes arrive by 10:16 (40 -> 10:10, 41 -> 10:15); route 41 departs
    // later (10:02 vs 10:00), so it ranks first.
    const itins = await arriveBy("401", "402", "2026-08-04T10:16:00-04:00", 2);
    expect(
      itins.map((i) => i.legs[0]?.type === "transit" && i.legs[0].route_id),
    ).toEqual(["41", "40"]);
    expect(itins.map((i) => i.depart_time)).toEqual([
      "2026-08-04T10:02:00-04:00",
      "2026-08-04T10:00:00-04:00",
    ]);
  });

  it("falls back to the anchor when the Δ-probe overshoots the target", async () => {
    // route 10 runs 101->103 at 08:00 (arr 08:10) and 08:30 (arr 08:40).
    // Arriving by 08:35: the Δ-probe (target − Δ − slack ≈ 08:05) depart-after
    // catches the 08:30 trip, which arrives 08:40 — past the target — so the
    // probe window finds nothing feasible and the emulation falls back to the
    // anchor's earliest-arrival solve (the 08:00 trip), the correct answer.
    const itins = await arriveBy("101", "103", "2026-08-04T08:35:00-04:00", 3);
    expect(itins).toHaveLength(1);
    expect(itins[0]?.depart_time).toBe("2026-08-04T08:00:00-04:00");
    expect(itins[0]?.arrive_time).toBe("2026-08-04T08:10:00-04:00");
    expect(new Date(itins[0]!.arrive_time).getTime()).toBeLessThanOrEqual(
      new Date("2026-08-04T08:35:00-04:00").getTime(),
    );
  });

  it("returns [] when nothing can arrive by the target", async () => {
    // Alpha->Beta service starts at 10:00; arriving by 09:00 is impossible.
    expect(
      await arriveBy("401", "402", "2026-08-04T09:00:00-04:00", 3),
    ).toEqual([]);
  });

  it("returns [] when the destination is unreachable", async () => {
    expect(
      await arriveBy("203", "101", "2026-08-04T20:00:00-04:00", 3),
    ).toEqual([]);
  });
});
