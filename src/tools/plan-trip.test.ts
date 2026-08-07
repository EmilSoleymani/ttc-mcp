import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unusedRtClient } from "../gtfs-rt/test-support.js";
import { buildRoutingFixtureDb } from "../gtfs/test-support.js";
import type { Candidates, Itinerary } from "../schemas/itinerary.js";
import type { ToolError } from "../errors.js";
import type { StopSummary } from "../schemas/stop.js";
import type { ServerDeps } from "../server.js";
import { callTool } from "./test-support.js";

interface PlanDto {
  from: StopSummary | null;
  to: StopSummary | null;
  itineraries: Itinerary[];
  candidates?: Candidates;
  error?: ToolError;
}

describe("plan_trip", () => {
  let db: Client;
  let deps: ServerDeps;
  beforeEach(async () => {
    db = await buildRoutingFixtureDb();
    deps = { db, rt: unusedRtClient() };
  });
  afterEach(() => {
    db.close();
  });

  it("plans a multimodal trip with a transfer", async () => {
    const result = await callTool(
      "plan_trip",
      { from: "101", to: "203", when: "2026-08-04T08:00:00-04:00" },
      deps,
    );
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as PlanDto;
    expect(dto.from?.stop_id).toBe("101");
    expect(dto.to?.stop_id).toBe("203");
    expect(dto.itineraries).toHaveLength(1);
    expect(dto.itineraries[0]?.transfers).toBe(1);
    expect(dto.itineraries[0]?.legs.map((l) => l.type)).toEqual([
      "transit",
      "transfer",
      "transit",
    ]);
  });

  it("returns candidates (success) for an ambiguous endpoint", async () => {
    const result = await callTool(
      "plan_trip",
      { from: "Broadview", to: "101" },
      deps,
    );
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as PlanDto;
    expect(dto.from).toBeNull();
    expect(dto.candidates?.endpoint).toBe("from");
    expect(dto.candidates?.matches).toHaveLength(2);
    expect(dto.itineraries).toEqual([]);
  });

  it("errors (not_found) for an unknown stop_id", async () => {
    const result = await callTool(
      "plan_trip",
      { from: "99999", to: "101" },
      deps,
    );
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as PlanDto;
    expect(dto.error?.code).toBe("not_found");
  });

  it("is success-shaped with no_results when nothing is reachable", async () => {
    const result = await callTool(
      "plan_trip",
      { from: "203", to: "101", when: "2026-08-04T08:00:00-04:00" },
      deps,
    );
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as PlanDto;
    expect(dto.from?.stop_id).toBe("203");
    expect(dto.itineraries).toEqual([]);
    expect(dto.error?.code).toBe("no_results");
  });

  it("reports arrive_by as unsupported for now", async () => {
    const result = await callTool(
      "plan_trip",
      { from: "101", to: "203", arrive_by: true },
      deps,
    );
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as PlanDto;
    expect(dto.error?.code).toBe("unsupported");
  });

  it("rejects an invalid `when`", async () => {
    const result = await callTool(
      "plan_trip",
      { from: "101", to: "203", when: "not-a-date" },
      deps,
    );
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as PlanDto;
    expect(dto.error?.code).toBe("invalid_argument");
  });
});
