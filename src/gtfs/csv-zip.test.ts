import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { streamCsvEntries, zipHasEntry } from "./csv-zip.js";

const FIXTURE_ZIP = fileURLToPath(
  new URL("../../test/fixtures/gtfs/mini-schedules.zip", import.meta.url),
);

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("streamCsvEntries", () => {
  it("streams parsed rows for a named entry, keyed by header", async () => {
    const rows = await collect(streamCsvEntries(FIXTURE_ZIP, "routes.txt"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      route_id: "1",
      route_short_name: "1",
      route_type: "1",
    });
  });

  it("streams the large stop_times entry row-by-row", async () => {
    const rows = await collect(streamCsvEntries(FIXTURE_ZIP, "stop_times.txt"));
    expect(rows).toHaveLength(4);
    expect(rows[2]).toMatchObject({
      trip_id: "900002",
      arrival_time: "25:10:00",
    });
  });

  it("throws for an entry that does not exist in the zip", async () => {
    await expect(
      collect(streamCsvEntries(FIXTURE_ZIP, "shapes.txt")),
    ).rejects.toThrow(/entry not found/i);
  });
});

describe("zipHasEntry", () => {
  it("detects present and absent entries", async () => {
    await expect(zipHasEntry(FIXTURE_ZIP, "stops.txt")).resolves.toBe(true);
    await expect(zipHasEntry(FIXTURE_ZIP, "pathways.txt")).resolves.toBe(false);
  });
});
