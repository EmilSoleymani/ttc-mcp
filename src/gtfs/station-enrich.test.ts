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
          stop_id: "662",
          stop_code: "662",
          stop_name: "Danforth at Kennedy",
          stop_lat: "43.7",
          stop_lon: "-79.2",
          parent_station: "",
          location_type: "",
        },
      ]),
    );
  });
  afterEach(() => {
    client.close();
  });

  it("links platforms and inserts station rows from Dataset B", async () => {
    const result = await enrichStationsFromDatasetB(
      client,
      // Dataset-B style stops.txt rows (extra columns present in the real feed
      // are ignored by the stops spec's mapRow).
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
          stop_id: "662",
          stop_code: "662",
          stop_name: "Danforth at Kennedy",
          stop_lat: "43.7",
          stop_lon: "-79.2",
          parent_station: "",
          location_type: "0",
        },
      ]),
    );

    expect(result).toEqual({ platformsLinked: 2, stationsInserted: 1 });

    const platform = await client.execute({
      sql: "SELECT parent_station, location_type FROM stops WHERE stop_id = 16073",
    });
    expect(Number(platform.rows[0]!.parent_station)).toBe(99993);
    expect(Number(platform.rows[0]!.location_type)).toBe(0);

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
});
