import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unusedRtClient } from "../gtfs-rt/test-support.js";
import { buildFixtureDb } from "../gtfs/test-support.js";
import type { RouteSummary } from "../schemas/stop.js";
import type { ServerDeps } from "../server.js";
import { callTool } from "./test-support.js";

describe("list_routes", () => {
  let db: Client;
  let deps: ServerDeps;
  beforeEach(async () => {
    db = await buildFixtureDb();
    deps = { db, rt: unusedRtClient() };
  });
  afterEach(() => {
    db.close();
  });

  it("returns the full catalog", async () => {
    const result = await callTool("list_routes", {}, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as { routes: RouteSummary[] };
    expect(dto.routes.map((r) => r.route_id).sort()).toEqual(["1", "900"]);
  });

  it("filters by mode", async () => {
    const result = await callTool("list_routes", { mode: "bus" }, deps);
    const dto = result.structuredContent as { routes: RouteSummary[] };
    expect(dto.routes).toEqual([
      expect.objectContaining({ route_id: "900", mode: "bus" }),
    ]);
  });
});
