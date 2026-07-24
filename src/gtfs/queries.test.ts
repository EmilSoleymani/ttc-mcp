import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { explainNextDeparturesPlan, nextDepartures } from "./queries.js";
import { ingestScheduleZip } from "./ingest.js";

const FIXTURE_ZIP = fileURLToPath(
  new URL("../../test/fixtures/gtfs/mini-schedules.zip", import.meta.url),
);

describe("next-departures query", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await ingestScheduleZip(FIXTURE_ZIP, [client]);
  });

  afterEach(() => {
    client.close();
  });

  it("returns departures at a stop from a given time, ordered ascending", async () => {
    const rows = await nextDepartures(client, 10004, 0, 10);
    expect(rows.map((r) => r["trip_id"])).toEqual([900001, 900002]);
    expect(rows[0]?.["dep"]).toBeLessThan(rows[1]?.["dep"] as number);
  });

  it("excludes departures before the requested time", async () => {
    const rows = await nextDepartures(client, 10004, 25 * 3600, 10);
    expect(rows.map((r) => r["trip_id"])).toEqual([900002]);
  });

  it("uses the (stop_id, dep) index rather than a full table scan", async () => {
    const plan = await explainNextDeparturesPlan(client, 10004, 0, 10);
    const planText = plan.join(" | ");
    expect(planText).toMatch(/ix_st_stop_dep/);
    expect(planText).not.toMatch(/SCAN stop_times\b(?!.*USING INDEX)/);
  });
});
