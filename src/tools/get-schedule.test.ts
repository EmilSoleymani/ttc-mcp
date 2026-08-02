import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unusedRtClient } from "../gtfs-rt/test-support.js";
import { buildFixtureDb } from "../gtfs/test-support.js";
import type { ScheduledDeparture } from "../schemas/schedule.js";
import type { StopSummary } from "../schemas/stop.js";
import type { ServerDeps } from "../server.js";
import { callTool } from "./test-support.js";

describe("get_schedule", () => {
  let db: Client;
  let deps: ServerDeps;
  beforeEach(async () => {
    db = await buildFixtureDb();
    deps = { db, rt: unusedRtClient() };
  });
  afterEach(() => {
    db.close();
  });

  it("returns the next departures at a stop", async () => {
    const result = await callTool(
      "get_schedule",
      { stop_id: "663", when: "2026-07-24T10:00:00-04:00", limit: 1 },
      deps,
    );
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as {
      stop: StopSummary;
      departures: ScheduledDeparture[];
      truncated: boolean;
    };
    expect(dto.stop.stop_id).toBe("663");
    expect(dto.departures).toEqual([
      expect.objectContaining({ route_id: "900", headsign: "Airport" }),
    ]);
  });

  it("defaults `when` to now", async () => {
    const result = await callTool("get_schedule", { stop_id: "663" }, deps);
    expect(result.isError).toBe(false);
  });

  it("errors with not_found for an unknown stop_id", async () => {
    const result = await callTool("get_schedule", { stop_id: "999999" }, deps);
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("not_found");
  });

  it("errors with invalid_argument for a non-numeric stop_id", async () => {
    const result = await callTool(
      "get_schedule",
      { stop_id: "not-an-id" },
      deps,
    );
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("invalid_argument");
  });

  it("errors with invalid_argument for a non-numeric route_id", async () => {
    const result = await callTool(
      "get_schedule",
      { stop_id: "663", route_id: "not-an-id" },
      deps,
    );
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("invalid_argument");
  });

  it("errors with invalid_argument for a malformed `when`", async () => {
    const result = await callTool(
      "get_schedule",
      { stop_id: "663", when: "not-a-date" },
      deps,
    );
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("invalid_argument");
  });
});
