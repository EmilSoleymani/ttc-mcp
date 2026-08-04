import { type Client, createClient } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CsvRow, enrichStationsFromDatasetB } from "./ingest.js";
import { loadTable, TABLE_SPECS } from "./ingest.js";
import { applySchema } from "./schema.js";

async function* asRecords(records: CsvRow[]): AsyncIterable<CsvRow> {
  await Promise.resolve();
  for (const r of records) yield r;
}

const stopsSpec = TABLE_SPECS.find((s) => s.table === "stops")!;

describe("enrichStationsFromDatasetB", () => {
  let client: Client;
  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "ttc-enrich-"));
    client = createClient({ url: `file:${join(dir, "fixture.db")}` });
    await applySchema(client);
    // Dataset-A style stops: station columns blank (the real feed's state).
    await loadTable(
      client,
      stopsSpec,
      asRecords([
        {
          stop_id: "16073",
          stop_code: "16073",
          stop_name: "Eglinton EB Platform",
          stop_lat: "43.7",
          stop_lon: "-79.4",
          parent_station: "",
          location_type: "",
        },
        {
          stop_id: "3765",
          stop_code: "3765",
          stop_name: "Islington Ave at Beaumonde",
          stop_lat: "43.6",
          stop_lon: "-79.5",
          parent_station: "",
          location_type: "",
        },
      ]),
    );
  });
  afterEach(() => {
    client.close();
  });

  it("links platforms by stop_code (not stop_id) and inserts station rows", async () => {
    const result = await enrichStationsFromDatasetB(
      client,
      // Dataset-B style stops.txt rows (extra columns present in the real feed
      // are ignored by the stops spec's mapRow). The two TTC feeds use
      // independent stop_id namespaces — stop_id 3765 collides here between
      // an unrelated Eglinton bus bay (B) and Islington Ave (A), but their
      // stop_codes differ, so the join must use stop_code to avoid stapling
      // the wrong parent_station onto Islington.
      asRecords([
        {
          stop_id: "99993",
          stop_code: "16999",
          stop_name: "Eglinton",
          stop_lat: "43.7",
          stop_lon: "-79.4",
          parent_station: "",
          location_type: "1",
        },
        {
          stop_id: "16073",
          stop_code: "16073",
          stop_name: "Eglinton EB Platform",
          stop_lat: "43.7",
          stop_lon: "-79.4",
          parent_station: "99993",
          location_type: "0",
        },
        {
          stop_id: "3765",
          stop_code: "90001",
          stop_name: "Eglinton Station Bus Bay 3",
          stop_lat: "43.7",
          stop_lon: "-79.4",
          parent_station: "99993",
          location_type: "0",
        },
        {
          stop_id: "7988",
          stop_code: "3765",
          stop_name: "Islington Ave at Beaumonde",
          stop_lat: "43.6",
          stop_lon: "-79.5",
          parent_station: "",
          location_type: "0",
        },
      ]),
    );

    expect(result).toEqual({ platformsLinked: 1, stationsInserted: 1 });

    const platform = await client.execute({
      sql: "SELECT parent_station FROM stops WHERE stop_id = 16073",
    });
    expect(Number(platform.rows[0]!.parent_station)).toBe(99993);

    // Anti-collision: stop_id 3765 collides across feeds, but stop_code 3765
    // correctly matches the parentless B Islington row, not the bus-bay that
    // shares Islington's Dataset-A stop_id. A stop_id join would wrongly set
    // this to 99993.
    const islington = await client.execute({
      sql: "SELECT parent_station FROM stops WHERE stop_id = 3765",
    });
    expect(islington.rows[0]!.parent_station).toBeNull();

    const station = await client.execute({
      sql: "SELECT location_type, stop_name FROM stops WHERE stop_id = 99993",
    });
    expect(Number(station.rows[0]!.location_type)).toBe(1);
    expect(station.rows[0]!.stop_name).toBe("Eglinton");

    // Staging table is transient — gone after enrichment.
    await expect(
      client.execute("SELECT 1 FROM stops_b LIMIT 1"),
    ).rejects.toThrow();
  });

  it("builds rt_stop_crosswalk mapping Dataset-B stop_id to Dataset-A stop_id via stop_code", async () => {
    await enrichStationsFromDatasetB(
      client,
      asRecords([
        {
          stop_id: "99993",
          stop_code: "16999",
          stop_name: "Eglinton",
          stop_lat: "43.7",
          stop_lon: "-79.4",
          parent_station: "",
          location_type: "1",
        },
        {
          stop_id: "16073",
          stop_code: "16073",
          stop_name: "Eglinton EB Platform",
          stop_lat: "43.7",
          stop_lon: "-79.4",
          parent_station: "99993",
          location_type: "0",
        },
        {
          stop_id: "3765",
          stop_code: "90001",
          stop_name: "Eglinton Station Bus Bay 3",
          stop_lat: "43.7",
          stop_lon: "-79.4",
          parent_station: "99993",
          location_type: "0",
        },
        {
          stop_id: "7988",
          stop_code: "3765",
          stop_name: "Islington Ave at Beaumonde",
          stop_lat: "43.6",
          stop_lon: "-79.5",
          parent_station: "",
          location_type: "0",
        },
      ]),
    );

    const rows = await client.execute(
      "SELECT rt_stop_id, stop_id FROM rt_stop_crosswalk ORDER BY rt_stop_id",
    );
    expect(
      rows.rows.map((r) => [Number(r.rt_stop_id), Number(r.stop_id)]),
    ).toEqual([
      [7988, 3765], // cross-namespace bridge: B stop_id 7988 (code 3765) -> A stop 3765
      [16073, 16073], // same number in both, still via stop_code
      [99993, 99993], // the station row this enrichment just inserted
    ]);
  });
});
