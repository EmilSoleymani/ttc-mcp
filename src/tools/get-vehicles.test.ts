import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fixtureVehiclesRtClient,
  unusedRtClient,
} from "../gtfs-rt/test-support.js";
import { buildFixtureDb } from "../gtfs/test-support.js";
import type { Vehicle } from "../schemas/vehicle.js";
import type { ServerDeps } from "../server.js";
import { callTool } from "./test-support.js";

describe("get_vehicles", () => {
  let db: Client;
  beforeEach(async () => {
    db = await buildFixtureDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns live vehicles for a bus/streetcar route, dropping deadheads and other routes", async () => {
    const deps: ServerDeps = {
      db,
      rt: fixtureVehiclesRtClient([
        { vehicleId: "8001", routeId: "900", lat: 43.7, lon: -79.6 },
        { vehicleId: "8002", routeId: "", lat: 43.7, lon: -79.6 }, // deadheading, empty route_id
        { vehicleId: "8003", routeId: "1", lat: 43.7, lon: -79.6 }, // a different route
      ]),
    };

    const result = await callTool("get_vehicles", { route_id: "900" }, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as {
      route_id: string;
      vehicles: Vehicle[];
      realtime_available: boolean;
      truncated: boolean;
    };
    expect(dto.route_id).toBe("900");
    expect(dto.realtime_available).toBe(true);
    expect(dto.truncated).toBe(false);
    expect(dto.vehicles).toHaveLength(1);
    expect(dto.vehicles[0]).toMatchObject({
      vehicle_id: "8001",
      route_id: "900",
    });
  });

  it("returns an empty, non-error result with a note for a subway route", async () => {
    const deps: ServerDeps = { db, rt: unusedRtClient() };
    const result = await callTool("get_vehicles", { route_id: "1" }, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as {
      vehicles: Vehicle[];
      realtime_available: boolean;
      note?: string;
    };
    expect(dto.vehicles).toEqual([]);
    expect(dto.realtime_available).toBe(false);
    expect(dto.note).toMatch(/subway/i);
  });

  it("caps results at `limit` and sets truncated", async () => {
    const deps: ServerDeps = {
      db,
      rt: fixtureVehiclesRtClient(
        Array.from({ length: 5 }, (_, i) => ({
          vehicleId: `800${String(i)}`,
          routeId: "900",
          lat: 43.7,
          lon: -79.6,
        })),
      ),
    };

    const result = await callTool(
      "get_vehicles",
      { route_id: "900", limit: 2 },
      deps,
    );
    const dto = result.structuredContent as {
      vehicles: Vehicle[];
      truncated: boolean;
    };
    expect(dto.vehicles).toHaveLength(2);
    expect(dto.truncated).toBe(true);
  });

  it("errors with not_found for an unknown route_id", async () => {
    const deps: ServerDeps = { db, rt: unusedRtClient() };
    const result = await callTool("get_vehicles", { route_id: "999999" }, deps);
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("not_found");
  });

  it("errors with invalid_argument for a non-numeric route_id", async () => {
    const deps: ServerDeps = { db, rt: unusedRtClient() };
    const result = await callTool(
      "get_vehicles",
      { route_id: "not-an-id" },
      deps,
    );
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("invalid_argument");
  });

  it("errors with upstream_unavailable when the RT feed fetch fails after retries", async () => {
    const deps: ServerDeps = {
      db,
      rt: fixtureVehiclesRtClient([], {
        fetchImpl: () => Promise.resolve(new Response(null, { status: 500 })),
        retryOptions: { retries: 0, baseDelayMs: 1 },
      }),
    };
    const result = await callTool("get_vehicles", { route_id: "900" }, deps);
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("upstream_unavailable");
  });
});
