import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Client, createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { applySchema } from "./schema.js";
import {
  buildPathwayTransfers,
  buildStationTransfers,
  buildStreetTransfers,
  insertTransfers,
  mergeTransfers,
  type TransferRow,
} from "./transfers.js";

describe("buildStationTransfers", () => {
  it("connects siblings sharing a parent_station, both directions", () => {
    const transfers = buildStationTransfers([
      { stop_id: 1, parent_station: 100, stop_lat: null, stop_lon: null },
      { stop_id: 2, parent_station: 100, stop_lat: null, stop_lon: null },
      { stop_id: 3, parent_station: null, stop_lat: null, stop_lon: null },
    ]);
    expect(transfers).toEqual(
      expect.arrayContaining([
        {
          from_stop_id: 1,
          to_stop_id: 2,
          min_walk_seconds: 60,
          type: "station",
        },
        {
          from_stop_id: 2,
          to_stop_id: 1,
          min_walk_seconds: 60,
          type: "station",
        },
      ]),
    );
    expect(
      transfers.some((t) => t.from_stop_id === 3 || t.to_stop_id === 3),
    ).toBe(false);
  });

  it("emits nothing for a parent with a single platform", () => {
    const transfers = buildStationTransfers([
      { stop_id: 1, parent_station: 100, stop_lat: null, stop_lon: null },
    ]);
    expect(transfers).toEqual([]);
  });
});

describe("buildPathwayTransfers", () => {
  it("uses traversal_time directly and mirrors bidirectional pathways", () => {
    const transfers = buildPathwayTransfers([
      {
        from_stop_id: 1,
        to_stop_id: 2,
        is_bidirectional: 1,
        traversal_time: 90,
        length: null,
      },
    ]);
    expect(transfers).toEqual([
      { from_stop_id: 1, to_stop_id: 2, min_walk_seconds: 90, type: "pathway" },
      { from_stop_id: 2, to_stop_id: 1, min_walk_seconds: 90, type: "pathway" },
    ]);
  });

  it("derives seconds from length ÷ 1.3 m/s when traversal_time is absent, one-way", () => {
    const transfers = buildPathwayTransfers([
      {
        from_stop_id: 2,
        to_stop_id: 3,
        is_bidirectional: 0,
        traversal_time: null,
        length: 130,
      },
    ]);
    expect(transfers).toEqual([
      {
        from_stop_id: 2,
        to_stop_id: 3,
        min_walk_seconds: 100,
        type: "pathway",
      },
    ]);
  });

  it("a subway interchange's walk time stays within a sane spot-check range", () => {
    // Real TTC interchange pathways (e.g. Bloor-Yonge) run tens of seconds to
    // a few minutes of platform-to-platform walking, never near-zero or
    // absurdly long.
    const [transfer] = buildPathwayTransfers([
      {
        from_stop_id: 1,
        to_stop_id: 2,
        is_bidirectional: 1,
        traversal_time: 120,
        length: null,
      },
    ]);
    expect(transfer!.min_walk_seconds).toBeGreaterThanOrEqual(15);
    expect(transfer!.min_walk_seconds).toBeLessThanOrEqual(600);
  });
});

describe("buildStreetTransfers", () => {
  const nearA = {
    stop_id: 1,
    parent_station: null,
    stop_lat: 43.7,
    stop_lon: -79.4,
  };
  const nearB = {
    stop_id: 2,
    parent_station: null,
    stop_lat: 43.7005,
    stop_lon: -79.4,
  }; // ~56m away
  const far = {
    stop_id: 3,
    parent_station: null,
    stop_lat: 43.8,
    stop_lon: -79.5,
  };

  it("connects stops within the radius, both directions, excludes far stops", () => {
    const transfers = buildStreetTransfers([nearA, nearB, far]);
    const ids = new Set(
      transfers.flatMap((t) => [t.from_stop_id, t.to_stop_id]),
    );
    expect(ids.has(3)).toBe(false);
    expect(transfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_stop_id: 1,
          to_stop_id: 2,
          type: "street",
        }),
        expect.objectContaining({
          from_stop_id: 2,
          to_stop_id: 1,
          type: "street",
        }),
      ]),
    );
  });

  it("computes walk time as distance ÷ walk speed", () => {
    const [transfer] = buildStreetTransfers([nearA, nearB]);
    // ~55.66m at 1.3 m/s ≈ 43s.
    expect(transfer!.min_walk_seconds).toBeGreaterThanOrEqual(40);
    expect(transfer!.min_walk_seconds).toBeLessThanOrEqual(46);
  });

  it("ignores stops with no coordinates", () => {
    const transfers = buildStreetTransfers([
      { stop_id: 1, parent_station: null, stop_lat: null, stop_lon: null },
      nearB,
    ]);
    expect(transfers).toEqual([]);
  });
});

describe("mergeTransfers", () => {
  it("prefers station over pathway over street for the same directed pair", () => {
    const station: TransferRow = {
      from_stop_id: 1,
      to_stop_id: 2,
      min_walk_seconds: 60,
      type: "station",
    };
    const street: TransferRow = {
      from_stop_id: 1,
      to_stop_id: 2,
      min_walk_seconds: 200,
      type: "street",
    };
    const untouched: TransferRow = {
      from_stop_id: 3,
      to_stop_id: 4,
      min_walk_seconds: 80,
      type: "pathway",
    };
    const merged = mergeTransfers([street], [untouched], [station]);
    expect(merged).toEqual(expect.arrayContaining([station, untouched]));
    expect(merged).toHaveLength(2);
  });
});

describe("insertTransfers", () => {
  let dbDir: string | undefined;
  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    dbDir = undefined;
  });

  function freshDb(): Client {
    dbDir = mkdtempSync(join(tmpdir(), "ttc-transfers-test-"));
    return createClient({ url: `file:${join(dbDir, "t.db")}` });
  }

  it("bulk-inserts and is queryable via the from_stop_id index", async () => {
    const client = freshDb();
    await applySchema(client);

    const rows: TransferRow[] = [
      { from_stop_id: 1, to_stop_id: 2, min_walk_seconds: 60, type: "station" },
      { from_stop_id: 2, to_stop_id: 1, min_walk_seconds: 60, type: "station" },
      { from_stop_id: 1, to_stop_id: 3, min_walk_seconds: 150, type: "street" },
    ];
    const count = await insertTransfers(client, rows);
    expect(count).toBe(3);

    const result = await client.execute({
      sql: "SELECT to_stop_id, min_walk_seconds, type FROM transfers WHERE from_stop_id = ? ORDER BY to_stop_id",
      args: [1],
    });
    expect(result.rows.map((r) => Number(r.to_stop_id))).toEqual([2, 3]);

    const plan = await client.execute({
      sql: "EXPLAIN QUERY PLAN SELECT * FROM transfers WHERE from_stop_id = ?",
      args: [1],
    });
    expect(JSON.stringify(plan.rows)).toContain("ix_transfers_from");

    client.close();
  });

  it("is a no-op for an empty transfer list", async () => {
    const client = freshDb();
    await applySchema(client);
    await expect(insertTransfers(client, [])).resolves.toBe(0);
    client.close();
  });
});
