import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unusedRtClient } from "./gtfs-rt/test-support.js";
import { buildFixtureDb } from "./gtfs/test-support.js";
import type { FareResult } from "./schemas/fare.js";
import type { RouteSummary, StopSummary } from "./schemas/stop.js";
import type { ServerDeps } from "./server.js";
import { readResource } from "./tools/test-support.js";

describe("ttc://fares resource", () => {
  it("returns the same fare DTO the get_fare tool does", async () => {
    const contents = await readResource("ttc://fares");
    expect(contents).toHaveLength(1);

    const entry = contents[0]!;
    expect(entry.uri).toBe("ttc://fares");
    expect(entry.mimeType).toBe("application/json");

    const dto = JSON.parse(entry.text) as FareResult;
    expect(dto.transfer.window_minutes).toBe(120);
    expect(dto.fares.length).toBeGreaterThan(0);
  });
});

describe("ttc://stops resource", () => {
  let db: Client;
  let deps: ServerDeps;
  beforeEach(async () => {
    db = await buildFixtureDb();
    deps = { db, rt: unusedRtClient() };
  });
  afterEach(() => {
    db.close();
  });

  it("returns the full stop catalog", async () => {
    const contents = await readResource("ttc://stops", deps);
    expect(contents).toHaveLength(1);

    const entry = contents[0]!;
    expect(entry.uri).toBe("ttc://stops");
    expect(entry.mimeType).toBe("application/json");

    const dto = JSON.parse(entry.text) as StopSummary[];
    expect(dto.map((s) => s.stop_id).sort()).toEqual([
      "662",
      "663",
      "9000",
      "9001",
    ]);
  });
});

describe("ttc://routes resource", () => {
  let db: Client;
  let deps: ServerDeps;
  beforeEach(async () => {
    db = await buildFixtureDb();
    deps = { db, rt: unusedRtClient() };
  });
  afterEach(() => {
    db.close();
  });

  it("returns the full route catalog", async () => {
    const contents = await readResource("ttc://routes", deps);
    expect(contents).toHaveLength(1);

    const entry = contents[0]!;
    expect(entry.uri).toBe("ttc://routes");
    expect(entry.mimeType).toBe("application/json");

    const dto = JSON.parse(entry.text) as RouteSummary[];
    expect(dto.map((r) => r.route_id).sort()).toEqual(["1", "900"]);
  });
});
