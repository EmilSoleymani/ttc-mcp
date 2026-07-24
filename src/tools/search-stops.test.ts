import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureDb } from "../gtfs/test-support.js";
import type { StopSummary } from "../schemas/stop.js";
import type { ServerDeps } from "../server.js";
import { callTool } from "./test-support.js";

describe("search_stops", () => {
  let db: Client;
  let deps: ServerDeps;
  beforeEach(async () => {
    db = await buildFixtureDb();
    deps = { db };
  });
  afterEach(() => {
    db.close();
  });

  it("searches by name", async () => {
    const result = await callTool("search_stops", { query: "Danforth" }, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as { stops: StopSummary[] };
    expect(dto.stops).toHaveLength(1);
    expect(dto.stops[0]?.name).toBe("Danforth Rd at Kennedy Rd");
  });

  it("searches by proximity", async () => {
    const result = await callTool(
      "search_stops",
      { near: { lat: 43.714379, lon: -79.260939, radius_m: 5000 } },
      deps,
    );
    const dto = result.structuredContent as { stops: StopSummary[] };
    expect(dto.stops.map((s) => s.stop_id)).toEqual(["662", "663"]);
  });

  it("filters by mode", async () => {
    const result = await callTool(
      "search_stops",
      { query: "Station", mode: "bus" },
      deps,
    );
    const dto = result.structuredContent as { stops: StopSummary[] };
    expect(dto.stops).toEqual([
      expect.objectContaining({ stop_id: "663", mode: "bus" }),
    ]);
  });

  it("errors with invalid_argument when neither query nor near is given", async () => {
    const result = await callTool("search_stops", {}, deps);
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as {
      error?: { code: string };
    };
    expect(dto.error?.code).toBe("invalid_argument");
  });
});
