import { type Client } from "@libsql/client";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixtureAlertsRtClient } from "../gtfs-rt/test-support.js";
import { buildFixtureDb } from "../gtfs/test-support.js";
import type { Alert } from "../schemas/alert.js";
import type { ServerDeps } from "../server.js";
import { callTool } from "./test-support.js";

const { transit_realtime } = GtfsRealtimeBindings;
const { Cause, Effect } = transit_realtime.Alert;

describe("get_alerts", () => {
  let db: Client;
  beforeEach(async () => {
    db = await buildFixtureDb();
  });
  afterEach(() => {
    db.close();
  });

  // buildFixtureDb seeds route "1" (subway, Line 1) and route "900" (bus).
  const fixtureAlerts = [
    {
      id: "subway-no-service",
      effect: Effect.NO_SERVICE,
      headerText: "Line 1 closed for the weekend",
      informedEntity: [{ routeId: "1" }],
    },
    {
      id: "bus-elevator",
      effect: Effect.ACCESSIBILITY_ISSUE,
      headerText: "Elevator out of service",
      informedEntity: [{ routeId: "900", stopId: "662" }],
    },
    {
      id: "bus-planned-construction",
      effect: Effect.DETOUR,
      cause: Cause.CONSTRUCTION,
      headerText: "Planned detour for road work",
      informedEntity: [{ routeId: "900" }],
    },
  ];

  it("surfaces subway alerts correctly (subway-inclusive, unlike get_vehicles)", async () => {
    const deps: ServerDeps = {
      db,
      rt: fixtureAlertsRtClient(fixtureAlerts),
    };
    const result = await callTool("get_alerts", { mode: "subway" }, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as {
      alerts: Alert[];
      truncated: boolean;
    };
    expect(dto.alerts).toHaveLength(1);
    expect(dto.alerts[0]).toMatchObject({
      id: "subway-no-service",
      category: "no_service",
      informed: { routes: ["1"], modes: ["subway"] },
    });
  });

  it("filters by route_id", async () => {
    const deps: ServerDeps = { db, rt: fixtureAlertsRtClient(fixtureAlerts) };
    const result = await callTool("get_alerts", { route_id: "900" }, deps);
    const dto = result.structuredContent as { alerts: Alert[] };
    expect(dto.alerts.map((a) => a.id).sort()).toEqual([
      "bus-elevator",
      "bus-planned-construction",
    ]);
  });

  it("filters by stop_id", async () => {
    const deps: ServerDeps = { db, rt: fixtureAlertsRtClient(fixtureAlerts) };
    const result = await callTool("get_alerts", { stop_id: "662" }, deps);
    const dto = result.structuredContent as { alerts: Alert[] };
    expect(dto.alerts.map((a) => a.id)).toEqual(["bus-elevator"]);
  });

  it("filters by derived category", async () => {
    const deps: ServerDeps = { db, rt: fixtureAlertsRtClient(fixtureAlerts) };
    const result = await callTool("get_alerts", { category: "planned" }, deps);
    const dto = result.structuredContent as { alerts: Alert[] };
    expect(dto.alerts.map((a) => a.id)).toEqual(["bus-planned-construction"]);
  });

  it("returns every alert when no filter is given", async () => {
    const deps: ServerDeps = { db, rt: fixtureAlertsRtClient(fixtureAlerts) };
    const result = await callTool("get_alerts", {}, deps);
    const dto = result.structuredContent as {
      alerts: Alert[];
      truncated: boolean;
    };
    expect(dto.alerts).toHaveLength(3);
    expect(dto.truncated).toBe(false);
  });

  it("caps results at `limit` and sets truncated", async () => {
    const deps: ServerDeps = { db, rt: fixtureAlertsRtClient(fixtureAlerts) };
    const result = await callTool("get_alerts", { limit: 2 }, deps);
    const dto = result.structuredContent as {
      alerts: Alert[];
      truncated: boolean;
    };
    expect(dto.alerts).toHaveLength(2);
    expect(dto.truncated).toBe(true);
  });

  it("errors with upstream_unavailable when the RT feed fetch fails after retries", async () => {
    const deps: ServerDeps = {
      db,
      rt: fixtureAlertsRtClient([], {
        fetchImpl: () => Promise.resolve(new Response(null, { status: 500 })),
        retryOptions: { retries: 0, baseDelayMs: 1 },
      }),
    };
    const result = await callTool("get_alerts", {}, deps);
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("upstream_unavailable");
  });

  it("returns an empty, non-error result when the feed has no alerts", async () => {
    const deps: ServerDeps = { db, rt: fixtureAlertsRtClient([]) };
    const result = await callTool("get_alerts", {}, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as { alerts: Alert[] };
    expect(dto.alerts).toEqual([]);
  });
});
