import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unusedRtClient } from "../gtfs-rt/test-support.js";
import { buildFixtureDb } from "../gtfs/test-support.js";
import type { RouteDetail } from "../schemas/route.js";
import type { ServerDeps } from "../server.js";
import { callTool } from "./test-support.js";

describe("get_route", () => {
  let db: Client;
  let deps: ServerDeps;
  beforeEach(async () => {
    db = await buildFixtureDb();
    deps = { db, rt: unusedRtClient() };
  });
  afterEach(() => {
    db.close();
  });

  it("returns a route with its directions and stops", async () => {
    const result = await callTool("get_route", { route_id: "900" }, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as { route: RouteDetail };
    expect(dto.route).toMatchObject({
      route_id: "900",
      mode: "bus",
      truncated: false,
    });
    expect(dto.route.directions).toEqual([
      { direction_id: 0, headsign: "Airport" },
    ]);
    expect(dto.route.stops_by_direction?.[0]?.stops).toHaveLength(2);
  });

  it("errors with not_found for an unknown route_id", async () => {
    const result = await callTool("get_route", { route_id: "999999" }, deps);
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("not_found");
  });

  it("errors with invalid_argument for a non-numeric route_id", async () => {
    const result = await callTool("get_route", { route_id: "not-an-id" }, deps);
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("invalid_argument");
  });
});
