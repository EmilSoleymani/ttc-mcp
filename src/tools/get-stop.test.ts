import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unusedRtClient } from "../gtfs-rt/test-support.js";
import { buildFixtureDb } from "../gtfs/test-support.js";
import type { StopDetail } from "../schemas/stop.js";
import type { ServerDeps } from "../server.js";
import { callTool } from "./test-support.js";

describe("get_stop", () => {
  let db: Client;
  let deps: ServerDeps;
  beforeEach(async () => {
    db = await buildFixtureDb();
    deps = { db, rt: unusedRtClient() };
  });
  afterEach(() => {
    db.close();
  });

  it("returns a station with its platform and aggregated route", async () => {
    const result = await callTool("get_stop", { stop_id: "9000" }, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as { stop: StopDetail };
    expect(dto.stop).toMatchObject({
      stop_id: "9000",
      name: "Union Station",
      mode: "subway",
      is_station: true,
    });
    expect(dto.stop.platforms).toHaveLength(1);
    expect(dto.stop.routes).toEqual([
      expect.objectContaining({ route_id: "1", mode: "subway" }),
    ]);
  });

  it("returns a surface stop", async () => {
    const result = await callTool("get_stop", { stop_id: "662" }, deps);
    const dto = result.structuredContent as { stop: StopDetail };
    expect(dto.stop.platforms).toBeUndefined();
    expect(dto.stop.routes).toEqual([
      expect.objectContaining({ route_id: "900", mode: "bus" }),
    ]);
  });

  it("errors with not_found for an unknown stop_id", async () => {
    const result = await callTool("get_stop", { stop_id: "999999" }, deps);
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("not_found");
  });

  it("errors with not_found for a stop with no scheduled service", async () => {
    const result = await callTool("get_stop", { stop_id: "9002" }, deps);
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("not_found");
  });

  it("errors with invalid_argument for a non-numeric stop_id", async () => {
    const result = await callTool("get_stop", { stop_id: "not-an-id" }, deps);
    expect(result.isError).toBe(true);
    const dto = result.structuredContent as { error?: { code: string } };
    expect(dto.error?.code).toBe("invalid_argument");
  });
});
