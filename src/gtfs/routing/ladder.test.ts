import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toIsoWithTorontoOffset } from "../service-time.js";
import { buildRoutingFixtureDb } from "../test-support.js";
import { type Label, runLadder } from "./ladder.js";

function iso(label: Label | undefined): string | undefined {
  return label ? toIsoWithTorontoOffset(new Date(label.arrival)) : undefined;
}

describe("runLadder (depart-after)", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildRoutingFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  const departAt = (t: string): number => new Date(t).getTime();

  it("walks a two-seat ride: subway, street transfer, then bus", async () => {
    const best = await runLadder(client, {
      originAccess: [{ stopId: 101, walk: 0 }],
      departMs: departAt("2026-08-04T08:00:00-04:00"),
      maxTransfers: 3,
    });

    expect(iso(best.get(101))).toBe("2026-08-04T08:00:00-04:00");
    expect(iso(best.get(103))).toBe("2026-08-04T08:10:00-04:00");
    expect(iso(best.get(201))).toBe("2026-08-04T08:11:30-04:00");
    expect(iso(best.get(203))).toBe("2026-08-04T08:30:00-04:00");

    const at103 = best.get(103)?.parent;
    expect(at103).toMatchObject({
      via: "transit",
      routeId: 10,
      boardStopId: 101,
    });
    const at201 = best.get(201)?.parent;
    expect(at201).toMatchObject({
      via: "transfer",
      fromStopId: 103,
      walkSeconds: 90,
    });
    const at203 = best.get(203)?.parent;
    expect(at203).toMatchObject({
      via: "transit",
      routeId: 20,
      boardStopId: 201,
    });
  });

  it("respects depart-after: a later departure catches the next trip", async () => {
    const best = await runLadder(client, {
      originAccess: [{ stopId: 101, walk: 0 }],
      departMs: departAt("2026-08-04T08:01:00-04:00"),
      maxTransfers: 3,
    });
    // 08:00 trip is missed; next route-10 trip departs 08:30, reaching 103 at 08:40.
    expect(iso(best.get(103))).toBe("2026-08-04T08:40:00-04:00");
  });

  it("a modes filter blocks the bus leg of the two-seat ride", async () => {
    const best = await runLadder(client, {
      originAccess: [{ stopId: 101, walk: 0 }],
      departMs: departAt("2026-08-04T08:00:00-04:00"),
      maxTransfers: 3,
      modes: ["subway"],
    });
    // The street transfer still reaches 201, but no bus can be boarded there.
    expect(iso(best.get(201))).toBe("2026-08-04T08:11:30-04:00");
    expect(best.has(203)).toBe(false);
  });

  it("honours maxTransfers: 0 transfers can't complete the two-seat ride", async () => {
    const best = await runLadder(client, {
      originAccess: [{ stopId: 101, walk: 0 }],
      departMs: departAt("2026-08-04T08:00:00-04:00"),
      maxTransfers: 0,
    });
    // Round 0 boards the subway (reaches 103) and relaxes the footpath to 201,
    // but there is no round 1 to board the bus.
    expect(best.has(103)).toBe(true);
    expect(best.has(203)).toBe(false);
  });
});
