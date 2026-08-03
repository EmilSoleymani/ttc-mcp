import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RtClient } from "../gtfs-rt/rt-client.js";
import {
  fixtureTripUpdatesRtClient,
  unusedRtClient,
} from "../gtfs-rt/test-support.js";
import { buildFixtureDb } from "../gtfs/test-support.js";
import type { Arrival } from "../schemas/arrival.js";
import type { ServerDeps } from "../server.js";
import { callTool } from "./test-support.js";

type Dto = {
  arrivals: Arrival[];
  realtime_available: boolean;
  truncated: boolean;
  error?: { code: string };
};

const soon = Math.floor(Date.now() / 1000) + 300;

describe("get_arrivals", () => {
  let db: Client;
  beforeEach(async () => {
    db = await buildFixtureDb();
    await db.execute(
      "INSERT INTO rt_stop_crosswalk (rt_stop_id, stop_id) VALUES (50662, 662)",
    );
  });
  afterEach(() => {
    db.close();
  });

  it("returns predicted arrivals for a bus stop with live data", async () => {
    const deps: ServerDeps = {
      db,
      rt: fixtureTripUpdatesRtClient([
        {
          routeId: "900",
          tripId: "999999",
          stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: soon }],
        },
      ]),
    };
    const result = await callTool("get_arrivals", { stop_id: "662" }, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as Dto;
    expect(dto.realtime_available).toBe(true);
    expect(dto.arrivals).toHaveLength(1);
    expect(dto.arrivals[0]).toMatchObject({
      route_id: "900",
      source: "predicted",
      realtime: true,
    });
  });

  it("falls back to scheduled for a subway stop (no RT fetch)", async () => {
    // Prove the subway gate actually skips the RT call, rather than
    // attempting it and swallowing a failure in the try/catch — a plain
    // unusedRtClient() (fetch rejects) can't tell those two cases apart.
    let fetchCalls = 0;
    const rt = new RtClient({
      cacheEnabled: false,
      fetchImpl: () => {
        fetchCalls++;
        return Promise.reject(
          new Error("Unexpected GTFS-RT fetch in this test."),
        );
      },
    });
    const deps: ServerDeps = { db, rt };
    const result = await callTool("get_arrivals", { stop_id: "9000" }, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as Dto;
    expect(dto.realtime_available).toBe(false);
    expect(dto.arrivals.length).toBeGreaterThan(0);
    expect(
      dto.arrivals.every(
        (a) => a.source === "scheduled" && a.realtime === false,
      ),
    ).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  it("falls back to scheduled when there is no live data in the window", async () => {
    const deps: ServerDeps = { db, rt: fixtureTripUpdatesRtClient([]) };
    const result = await callTool("get_arrivals", { stop_id: "662" }, deps);
    const dto = result.structuredContent as Dto;
    expect(dto.realtime_available).toBe(false);
    expect(dto.arrivals.length).toBeGreaterThan(0);
    expect(dto.arrivals.every((a) => a.source === "scheduled")).toBe(true);
  });

  it("falls back to scheduled when the RT fetch fails", async () => {
    const deps: ServerDeps = { db, rt: unusedRtClient() };
    const result = await callTool("get_arrivals", { stop_id: "662" }, deps);
    const dto = result.structuredContent as Dto;
    expect(dto.realtime_available).toBe(false);
    expect(dto.arrivals.length).toBeGreaterThan(0);
    expect(dto.arrivals.every((a) => a.source === "scheduled")).toBe(true);
  });

  it("errors invalid_argument for a non-numeric stop_id", async () => {
    const deps: ServerDeps = { db, rt: unusedRtClient() };
    const result = await callTool("get_arrivals", { stop_id: "abc" }, deps);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as Dto).error?.code).toBe(
      "invalid_argument",
    );
  });

  it("errors not_found for an unknown stop_id", async () => {
    const deps: ServerDeps = { db, rt: unusedRtClient() };
    const result = await callTool("get_arrivals", { stop_id: "999999" }, deps);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as Dto).error?.code).toBe("not_found");
  });
});
