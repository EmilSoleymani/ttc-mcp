import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureDb, buildRoutingFixtureDb } from "../test-support.js";
import { accessStops, resolveBothEndpoints, resolveEndpoint } from "./index.js";

describe("access-stop expansion", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildRoutingFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  it("expands a stop_id to itself (walk 0) plus footpath neighbours", async () => {
    const access = await accessStops(client, { stop_id: 103 });
    const byId = Object.fromEntries(access.map((a) => [a.stop.stop_id, a]));
    expect(byId["103"]?.walk_seconds).toBe(0);
    expect(byId["201"]?.walk_seconds).toBe(90);
  });

  it("expands a station to its boardable platforms, not the parent", async () => {
    // The catalog fixture: Union Station 9000 (parent) with platform 9001.
    const stationClient = await buildFixtureDb();
    try {
      const access = await accessStops(stationClient, { stop_id: 9000 });
      const ids = access.map((a) => a.stop.stop_id);
      expect(ids).toContain("9001");
      expect(ids).not.toContain("9000");
      expect(access.every((a) => a.walk_seconds === 0)).toBe(true);
    } finally {
      stationClient.close();
    }
  });

  it("snaps a coordinate to nearby stops with sane walk times", async () => {
    const access = await accessStops(client, { lat: 43.6501, lon: -79.38 });
    expect(access.length).toBeGreaterThan(0);
    expect(access.length).toBeLessThanOrEqual(8);
    const nearest = access[0];
    if (!nearest) throw new Error("expected an access stop");
    expect(nearest.stop.stop_id).toBe("101");
    expect(nearest.walk_seconds).toBeGreaterThanOrEqual(0);
    expect(nearest.walk_seconds).toBeLessThan(60);
  });
});

describe("endpoint resolution", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildRoutingFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  it("resolves a known stop_id", async () => {
    const r = await resolveEndpoint(client, "101");
    expect(r).toMatchObject({ kind: "resolved" });
    if (r.kind === "resolved") expect(r.stop.name).toBe("Distillery Loop");
  });

  it("not_found for an unknown stop_id", async () => {
    expect((await resolveEndpoint(client, "99999")).kind).toBe("not_found");
  });

  it("resolves a unique name", async () => {
    const r = await resolveEndpoint(client, "Distillery");
    expect(r).toMatchObject({ kind: "resolved" });
    if (r.kind === "resolved") expect(r.stop.stop_id).toBe("101");
  });

  it("returns candidates for an ambiguous name", async () => {
    const r = await resolveEndpoint(client, "Broadview");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.matches.map((m) => m.name).sort()).toEqual([
        "Broadview Junction",
        "Broadview Station",
      ]);
    }
  });

  it("resolves a coordinate to the nearest stop", async () => {
    const r = await resolveEndpoint(client, { lat: 43.6501, lon: -79.38 });
    expect(r).toMatchObject({ kind: "resolved" });
    if (r.kind === "resolved") expect(r.stop.stop_id).toBe("101");
  });

  it("not_found for a coordinate with nothing nearby", async () => {
    expect((await resolveEndpoint(client, { lat: 0, lon: 0 })).kind).toBe(
      "not_found",
    );
  });
});

describe("resolveBothEndpoints", () => {
  let client: Client;
  beforeEach(async () => {
    client = await buildRoutingFixtureDb();
  });
  afterEach(() => {
    client.close();
  });

  it("reports from-ambiguity before to-ambiguity", async () => {
    const r = await resolveBothEndpoints(client, "Broadview", "Broadview");
    expect(r).toMatchObject({ kind: "candidates" });
    if (r.kind === "candidates") expect(r.candidates.endpoint).toBe("from");
  });

  it("reports to-ambiguity when from is unique", async () => {
    const r = await resolveBothEndpoints(client, "Distillery", "Broadview");
    expect(r).toMatchObject({ kind: "candidates" });
    if (r.kind === "candidates") expect(r.candidates.endpoint).toBe("to");
  });

  it("returns both stops when unambiguous", async () => {
    const r = await resolveBothEndpoints(client, "Distillery", "Midtown");
    expect(r).toMatchObject({ kind: "ok" });
    if (r.kind === "ok") {
      expect(r.from.stop_id).toBe("101");
      expect(r.to.stop_id).toBe("102");
    }
  });

  it("surfaces a not_found endpoint as an error", async () => {
    const r = await resolveBothEndpoints(client, "99999", "Distillery");
    expect(r).toMatchObject({ kind: "error" });
    if (r.kind === "error") expect(r.error.code).toBe("not_found");
  });
});
