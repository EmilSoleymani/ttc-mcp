# get_arrivals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `get_arrivals` MCP tool — live predicted arrivals for bus/streetcar, transparent scheduled fallback for subway / no-live stops — backed by an offline RT→static stop crosswalk.

**Architecture:** An ingest-time `rt_stop_crosswalk` table maps GTFS-RT `stopId` (Dataset B namespace) to the ingested (Dataset A) `stop_id`. A new arrivals repository indexes decoded TripUpdates by crosswalked stop and enriches identity via the existing `#9` join units; the tool handler chooses predicted vs. the existing `getSchedule` path and always answers.

**Tech Stack:** TypeScript (Node ESM, `.js` import specifiers), `@libsql/client`, `gtfs-realtime-bindings`, Zod, Vitest.

**Design spec:** `docs/superpowers/specs/2026-08-03-get-arrivals-design.md`.

## Global Constraints

- Node ESM: **every relative import ends in `.js`** (even for `.ts` files).
- All emitted times are absolute ISO 8601 America/Toronto via `toTorontoIso` (`src/gtfs-rt/vehicles-repository.js`).
- `limit` default **20**, hard cap **20**.
- Never-drop: an arrival is dropped only when `resolveArrivalIdentity` returns `undefined`; a failed `trip_id` join never drops.
- For all 233 TTC routes `route_id == route_short_name` (both the RT `routeId` filter key and the `route_short_name` source).
- `delay_seconds`, and real `direction_id`/`headsign`, are **out of scope** here (→ #33). Predicted arrivals carry `headsign` = RT headsign or `""`, `direction_id` = 0.
- Each task ends green on: `npm run typecheck && npm run lint && npm run format:check && npm test`.

---

### Task 1: `rt_stop_crosswalk` table + ingest population

**Files:**
- Modify: `src/gtfs/schema.ts` (add table to `SCHEMA_STATEMENTS`)
- Modify: `src/gtfs/ingest.ts` (`enrichStationsFromDatasetB`, before `DROP TABLE IF EXISTS stops_b`)
- Test: `src/gtfs/station-enrich.test.ts` (add a case)

**Interfaces:**
- Consumes: existing `enrichStationsFromDatasetB(client, bStops)`, `applySchema`, `loadTable`, `TABLE_SPECS`.
- Produces: table `rt_stop_crosswalk(rt_stop_id INTEGER PRIMARY KEY, stop_id INTEGER NOT NULL)` populated during ingest; no signature change (return shape of `enrichStationsFromDatasetB` unchanged).

- [ ] **Step 1: Write the failing test**

Add this `it(...)` inside the existing `describe("enrichStationsFromDatasetB", ...)` block in `src/gtfs/station-enrich.test.ts` (its `beforeEach` already seeds Dataset-A stops 16073/3765):

```ts
it("builds rt_stop_crosswalk mapping Dataset-B stop_id to Dataset-A stop_id via stop_code", async () => {
  await enrichStationsFromDatasetB(
    client,
    asRecords([
      { stop_id: "99993", stop_code: "16999", stop_name: "Eglinton", stop_lat: "43.7", stop_lon: "-79.4", parent_station: "", location_type: "1" },
      { stop_id: "16073", stop_code: "16073", stop_name: "Eglinton EB Platform", stop_lat: "43.7", stop_lon: "-79.4", parent_station: "99993", location_type: "0" },
      { stop_id: "3765", stop_code: "90001", stop_name: "Eglinton Station Bus Bay 3", stop_lat: "43.7", stop_lon: "-79.4", parent_station: "99993", location_type: "0" },
      { stop_id: "7988", stop_code: "3765", stop_name: "Islington Ave at Beaumonde", stop_lat: "43.6", stop_lon: "-79.5", parent_station: "", location_type: "0" },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gtfs/station-enrich.test.ts -t "rt_stop_crosswalk"`
Expected: FAIL — `no such table: rt_stop_crosswalk`.

- [ ] **Step 3: Add the table to the schema**

In `src/gtfs/schema.ts`, add a drop near the other `DROP TABLE` lines (order-independent, but keep it with the rest):

```ts
  "DROP TABLE IF EXISTS rt_stop_crosswalk",
```

and add the create + index at the end of the `SCHEMA_STATEMENTS` array (after the `transfers` index):

```ts
  // RT->static stop crosswalk (#11): GTFS-RT stopTimeUpdate.stopId is the
  // Dataset B stop_id namespace; B.stop_code == the ingested (Dataset A)
  // stop_id. Built at ingest from Dataset B — no runtime dependency.
  `CREATE TABLE rt_stop_crosswalk (
     rt_stop_id INTEGER PRIMARY KEY,
     stop_id INTEGER NOT NULL
   )`,
  "CREATE INDEX ix_rt_stop_crosswalk_stop ON rt_stop_crosswalk(stop_id)",
```

- [ ] **Step 4: Populate it during enrichment**

In `src/gtfs/ingest.ts`, inside `enrichStationsFromDatasetB`, insert this **immediately before** the `await client.execute("DROP TABLE IF EXISTS stops_b");` line:

```ts
  // Build the RT stop crosswalk while stops_b is still live: RT feeds key
  // stops by Dataset B stop_id, and B.stop_code is the ingested stop_id.
  // Join through `stops` so every row points at a real ingested stop; OR
  // IGNORE guards the (real-data-absent) case of a duplicate A stop_code.
  await client.execute(
    `INSERT OR IGNORE INTO rt_stop_crosswalk (rt_stop_id, stop_id)
     SELECT b.stop_id, s.stop_id
       FROM stops_b b JOIN stops s ON s.stop_code = b.stop_code`,
  );
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/gtfs/station-enrich.test.ts`
Expected: PASS (existing enrichment case + the new crosswalk case).

- [ ] **Step 6: Full check + commit**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
git add src/gtfs/schema.ts src/gtfs/ingest.ts src/gtfs/station-enrich.test.ts
git commit -m "feat(get_arrivals): rt_stop_crosswalk table built at ingest (#11)"
```

---

### Task 2: Arrival schema + arrivals repository (`predictedArrivals`)

**Files:**
- Create: `src/schemas/arrival.ts`
- Create: `src/gtfs-rt/arrivals-repository.ts`
- Test: `src/gtfs-rt/arrivals-repository.test.ts`

**Interfaces:**
- Consumes: `toTorontoIso` (`../gtfs-rt/vehicles-repository.js`), `parseRtTripId` + `getStaticTripById` (`../gtfs/trips-repository.js`), `resolveArrivalIdentity` (`./trip-join.js`), `transit_realtime.ITripUpdate`, `buildFixtureDb` + `fixtureTripUpdatesRtClient` in tests.
- Produces:
  - `arrivalSchema` / `type Arrival`, `getArrivalsInputShape`, `getArrivalsOutputShape` (`../schemas/arrival.js`).
  - `predictedArrivals(client, tripUpdates, targetStopIds, routeId, now, limit) => Promise<{ arrivals: Arrival[]; truncated: boolean }>`.

- [ ] **Step 1: Create the Arrival schema**

Create `src/schemas/arrival.ts`:

```ts
import { z } from "zod";

import { toolErrorSchema } from "../errors.js";
import { stopSummarySchema } from "./stop.js";

// docs/spec/tool-schemas.md #6. delay_seconds is deferred to #33.
export const arrivalSchema = z.object({
  route_id: z.string(),
  route_short_name: z.string().optional(),
  headsign: z.string(),
  direction_id: z.number().int(),
  time: z.string(),
  realtime: z.boolean(),
  source: z.enum(["predicted", "scheduled"]),
  delay_seconds: z.number().int().optional(),
});
export type Arrival = z.infer<typeof arrivalSchema>;

export const getArrivalsInputShape = {
  stop_id: z.string().describe("The stop_id (or station id) to look up."),
  route_id: z.string().optional().describe("Optional route_id filter."),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Max results (default 20, capped at 20)."),
};

export const getArrivalsOutputShape = {
  stop: stopSummarySchema.optional(),
  arrivals: z.array(arrivalSchema),
  realtime_available: z.boolean(),
  truncated: z.boolean(),
  hint: z.string().optional(),
  error: toolErrorSchema.optional(),
};
```

- [ ] **Step 2: Write the failing repository test**

Create `src/gtfs-rt/arrivals-repository.test.ts`:

```ts
import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFixtureDb } from "../gtfs/test-support.js";
import { predictedArrivals } from "./arrivals-repository.js";
import { fixtureTripUpdatesRtClient } from "./test-support.js";

// Fixture routes/stops come from buildFixtureDb: route 900 (bus) serves
// stops 662 and 663. We add crosswalk rows mapping RT stop ids 50662->662
// and 50663->663 (the Dataset-B-namespace ids the RT feed would carry).
async function seedCrosswalk(db: Client): Promise<void> {
  await db.execute(
    "INSERT INTO rt_stop_crosswalk (rt_stop_id, stop_id) VALUES (50662, 662), (50663, 663)",
  );
}

const soon = Math.floor(Date.now() / 1000) + 300;
const later = soon + 300;

describe("predictedArrivals", () => {
  let db: Client;
  beforeEach(async () => {
    db = await buildFixtureDb();
    await seedCrosswalk(db);
  });
  afterEach(() => {
    db.close();
  });

  it("returns a predicted arrival for a crosswalked stop, route enriched, unmatched trip -> headsign '' dir 0", async () => {
    const rt = fixtureTripUpdatesRtClient([
      { routeId: "900", tripId: "999999", stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: soon }] },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals, truncated } = await predictedArrivals(db, updates, [662], undefined, new Date(), 20);
    expect(truncated).toBe(false);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({
      route_id: "900",
      route_short_name: "900",
      headsign: "",
      direction_id: 0,
      realtime: true,
      source: "predicted",
    });
    expect(arrivals[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(arrivals[0]!.delay_seconds).toBeUndefined();
  });

  it("skips past times and stops with no crosswalk row", async () => {
    const rt = fixtureTripUpdatesRtClient([
      { routeId: "900", stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: Math.floor(Date.now() / 1000) - 60 }] },
      { routeId: "900", stopTimeUpdates: [{ stopId: "77777", arrivalSeconds: soon }] },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals } = await predictedArrivals(db, updates, [662, 663], undefined, new Date(), 20);
    expect(arrivals).toEqual([]);
  });

  it("filters by route_id and sorts by time", async () => {
    const rt = fixtureTripUpdatesRtClient([
      { routeId: "1", stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: soon }] },
      { routeId: "900", stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: later }] },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals } = await predictedArrivals(db, updates, [662], "900", new Date(), 20);
    expect(arrivals.map((a) => a.route_id)).toEqual(["900"]);
  });

  it("caps at limit and reports truncated across station platforms", async () => {
    const rt = fixtureTripUpdatesRtClient([
      { routeId: "900", stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: soon }] },
      { routeId: "900", stopTimeUpdates: [{ stopId: "50663", arrivalSeconds: later }] },
    ]);
    const updates = await rt.getTripUpdates();
    const { arrivals, truncated } = await predictedArrivals(db, updates, [662, 663], undefined, new Date(), 1);
    expect(arrivals).toHaveLength(1);
    expect(truncated).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/gtfs-rt/arrivals-repository.test.ts`
Expected: FAIL — cannot find module `./arrivals-repository.js`.

- [ ] **Step 4: Implement the repository**

Create `src/gtfs-rt/arrivals-repository.ts`:

```ts
import type { Client } from "@libsql/client";
import type { transit_realtime } from "gtfs-realtime-bindings";
import type Long from "long";

import { getStaticTripById, parseRtTripId } from "../gtfs/trips-repository.js";
import type { Arrival } from "../schemas/arrival.js";
import { resolveArrivalIdentity } from "./trip-join.js";
import { toTorontoIso } from "./vehicles-repository.js";

function epochToNumber(value: number | Long | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "number" ? value : value.toNumber();
}

/** RT stop ids (as strings, matching the wire) for the given static stop ids. */
async function crosswalkForStops(
  client: Client,
  stopIds: number[],
): Promise<Map<string, number>> {
  const placeholders = stopIds.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT rt_stop_id, stop_id FROM rt_stop_crosswalk WHERE stop_id IN (${placeholders})`,
    args: stopIds,
  });
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(String(row.rt_stop_id), Number(row.stop_id));
  }
  return map;
}

/** route_id -> route_short_name for the given ids (route_id == route_short_name for TTC). */
async function routeShortNames(
  client: Client,
  routeIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (routeIds.length === 0) return map;
  const placeholders = routeIds.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT route_id, route_short_name FROM routes WHERE route_id IN (${placeholders})`,
    args: routeIds.map(Number),
  });
  for (const row of result.rows) {
    if (row.route_short_name !== null && row.route_short_name !== undefined) {
      map.set(String(row.route_id), String(row.route_short_name));
    }
  }
  return map;
}

/**
 * Predicted arrivals at `targetStopIds` (the queried stop, or a station's
 * platform ids) from a decoded TripUpdates feed. Predictions are located by
 * crosswalking each RT stopId to a static stop_id; identity is resolved with
 * the #9 join units (trip_id is 0% against live TTC, so this is the RT-only
 * fallback path in practice). Sorted by time, capped at `limit`.
 */
export async function predictedArrivals(
  client: Client,
  tripUpdates: transit_realtime.ITripUpdate[],
  targetStopIds: number[],
  routeId: string | undefined,
  now: Date,
  limit: number,
): Promise<{ arrivals: Arrival[]; truncated: boolean }> {
  if (targetStopIds.length === 0) return { arrivals: [], truncated: false };
  const crosswalk = await crosswalkForStops(client, targetStopIds);
  if (crosswalk.size === 0) return { arrivals: [], truncated: false };

  const nowMs = now.getTime();
  const predictions: { trip: transit_realtime.ITripDescriptor; epoch: number }[] = [];
  for (const update of tripUpdates) {
    const trip = update.trip;
    if (!trip) continue;
    if (routeId !== undefined && trip.routeId !== routeId) continue;
    for (const stu of update.stopTimeUpdate ?? []) {
      if (stu.stopId === null || stu.stopId === undefined) continue;
      if (!crosswalk.has(stu.stopId)) continue;
      const epoch = epochToNumber(stu.arrival?.time) ?? epochToNumber(stu.departure?.time);
      if (epoch === undefined || epoch * 1000 < nowMs) continue;
      predictions.push({ trip, epoch });
    }
  }

  predictions.sort((a, b) => a.epoch - b.epoch);
  const window = predictions.slice(0, limit + 1);

  const identities: { identity: NonNullable<ReturnType<typeof resolveArrivalIdentity>>; epoch: number }[] = [];
  for (const { trip, epoch } of window) {
    const key = parseRtTripId(trip.tripId);
    const staticTrip = key === null ? undefined : await getStaticTripById(client, key);
    const identity = resolveArrivalIdentity(trip, staticTrip);
    if (identity) identities.push({ identity, epoch });
  }

  const shortNames = await routeShortNames(
    client,
    [...new Set(identities.map((i) => i.identity.route_id))],
  );

  const arrivals: Arrival[] = identities.map(({ identity, epoch }) => {
    const shortName = identity.route_short_name ?? shortNames.get(identity.route_id);
    return {
      route_id: identity.route_id,
      ...(shortName !== undefined ? { route_short_name: shortName } : {}),
      headsign: identity.headsign,
      direction_id: identity.direction_id,
      time: toTorontoIso(epoch),
      realtime: true,
      source: "predicted" as const,
    };
  });

  return { arrivals: arrivals.slice(0, limit), truncated: arrivals.length > limit };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/gtfs-rt/arrivals-repository.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 6: Full check + commit**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
git add src/schemas/arrival.ts src/gtfs-rt/arrivals-repository.ts src/gtfs-rt/arrivals-repository.test.ts
git commit -m "feat(get_arrivals): Arrival schema + predictedArrivals repository (#11)"
```

---

### Task 3: `get_arrivals` tool + registration

**Files:**
- Modify: `src/gtfs/schedule-repository.ts` (export the stop-summary helper)
- Create: `src/tools/get-arrivals.ts`
- Modify: `src/server.ts` (register)
- Test: `src/tools/get-arrivals.test.ts`

**Interfaces:**
- Consumes: `predictedArrivals` (Task 2), `getArrivalsInputShape`/`getArrivalsOutputShape`/`Arrival` (Task 2), `getSchedule` + `toStopSummary` (`../gtfs/schedule-repository.js`), `getStopById` (`../gtfs/stops-repository.js`), `toolError` (`../errors.js`), `ServerDeps`, `callTool` test helper.
- Produces: `registerGetArrivals(server, deps)`; DTO `{ stop?, arrivals, realtime_available, truncated, hint?, error? }`.

- [ ] **Step 1: Export the stop-summary helper**

In `src/gtfs/schedule-repository.ts`, change the private `function toStopSummaryOnly(` to an exported, renamed helper and update its one call site:

```ts
export function toStopSummary(detail: StopDetail): StopSummary {
```

Then update the single reference inside `getSchedule` (`const stop = toStopSummaryOnly(stopDetail);`) to `toStopSummary(stopDetail)`.

- [ ] **Step 2: Write the failing tool test**

Create `src/tools/get-arrivals.test.ts`:

```ts
import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixtureTripUpdatesRtClient, unusedRtClient } from "../gtfs-rt/test-support.js";
import { buildFixtureDb } from "../gtfs/test-support.js";
import type { Arrival } from "../schemas/arrival.js";
import type { ServerDeps } from "../server.js";
import { callTool } from "./test-support.js";

type Dto = {
  arrivals: Arrival[];
  realtime_available: boolean;
  truncated: boolean;
  error?: { code: string };
};

const soon = Math.floor(Date.now() / 1000) + 300;

describe("get_arrivals", () => {
  let db: Client;
  beforeEach(async () => {
    db = await buildFixtureDb();
    await db.execute("INSERT INTO rt_stop_crosswalk (rt_stop_id, stop_id) VALUES (50662, 662)");
  });
  afterEach(() => {
    db.close();
  });

  it("returns predicted arrivals for a bus stop with live data", async () => {
    const deps: ServerDeps = {
      db,
      rt: fixtureTripUpdatesRtClient([
        { routeId: "900", tripId: "999999", stopTimeUpdates: [{ stopId: "50662", arrivalSeconds: soon }] },
      ]),
    };
    const result = await callTool("get_arrivals", { stop_id: "662" }, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as Dto;
    expect(dto.realtime_available).toBe(true);
    expect(dto.arrivals).toHaveLength(1);
    expect(dto.arrivals[0]).toMatchObject({ route_id: "900", source: "predicted", realtime: true });
  });

  it("falls back to scheduled for a subway stop (no RT fetch)", async () => {
    const deps: ServerDeps = { db, rt: unusedRtClient() };
    const result = await callTool("get_arrivals", { stop_id: "9000" }, deps);
    expect(result.isError).toBe(false);
    const dto = result.structuredContent as Dto;
    expect(dto.realtime_available).toBe(false);
    expect(dto.arrivals.every((a) => a.source === "scheduled" && a.realtime === false)).toBe(true);
  });

  it("falls back to scheduled when there is no live data in the window", async () => {
    const deps: ServerDeps = { db, rt: fixtureTripUpdatesRtClient([]) };
    const result = await callTool("get_arrivals", { stop_id: "662" }, deps);
    const dto = result.structuredContent as Dto;
    expect(dto.realtime_available).toBe(false);
    expect(dto.arrivals.every((a) => a.source === "scheduled")).toBe(true);
  });

  it("falls back to scheduled when the RT fetch fails", async () => {
    const deps: ServerDeps = { db, rt: unusedRtClient() }; // any getTripUpdates() call rejects
    const result = await callTool("get_arrivals", { stop_id: "662" }, deps);
    const dto = result.structuredContent as Dto;
    expect(dto.realtime_available).toBe(false);
    expect(dto.arrivals.every((a) => a.source === "scheduled")).toBe(true);
  });

  it("errors invalid_argument for a non-numeric stop_id", async () => {
    const deps: ServerDeps = { db, rt: unusedRtClient() };
    const result = await callTool("get_arrivals", { stop_id: "abc" }, deps);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as Dto).error?.code).toBe("invalid_argument");
  });

  it("errors not_found for an unknown stop_id", async () => {
    const deps: ServerDeps = { db, rt: unusedRtClient() };
    const result = await callTool("get_arrivals", { stop_id: "999999" }, deps);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as Dto).error?.code).toBe("not_found");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/tools/get-arrivals.test.ts`
Expected: FAIL — tool `get_arrivals` not registered (`callTool` throws unknown tool).

- [ ] **Step 4: Implement the tool**

Create `src/tools/get-arrivals.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { toolError } from "../errors.js";
import { predictedArrivals } from "../gtfs-rt/arrivals-repository.js";
import { getSchedule, toStopSummary } from "../gtfs/schedule-repository.js";
import { getStopById } from "../gtfs/stops-repository.js";
import type { Arrival } from "../schemas/arrival.js";
import { getArrivalsInputShape, getArrivalsOutputShape } from "../schemas/arrival.js";
import type { ServerDeps } from "../server.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;

function errorResult(
  code: Parameters<typeof toolError>[0],
  message: string,
): CallToolResult {
  const dto = { arrivals: [], realtime_available: false, truncated: false, error: toolError(code, message) };
  return { content: [{ type: "text", text: JSON.stringify(dto) }], structuredContent: dto, isError: true };
}

function ok(dto: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(dto) }], structuredContent: dto };
}

export function registerGetArrivals(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_arrivals",
    {
      title: "Get live arrivals at a TTC stop",
      description:
        "Next arrivals at a stop_id (or station, aggregated across platforms). Live predicted times for bus/streetcar; subway and stops with no live trips fall back to scheduled times. Times are absolute ISO 8601 (America/Toronto).",
      inputSchema: getArrivalsInputShape,
      outputSchema: getArrivalsOutputShape,
    },
    async ({ stop_id, route_id, limit }): Promise<CallToolResult> => {
      const stopId = Number(stop_id);
      if (!Number.isInteger(stopId)) {
        return errorResult("invalid_argument", `stop_id must be a numeric string, got "${stop_id}".`);
      }
      let routeIdNum: number | undefined;
      if (route_id !== undefined) {
        routeIdNum = Number(route_id);
        if (!Number.isInteger(routeIdNum)) {
          return errorResult("invalid_argument", `route_id must be a numeric string, got "${route_id}".`);
        }
      }

      const stopDetail = await getStopById(deps.db, stopId);
      if (!stopDetail) {
        return errorResult("not_found", `No stop found with stop_id "${stop_id}".`);
      }

      const cap = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const targetStopIds = stopDetail.is_station
        ? (stopDetail.platforms ?? []).map((p) => Number(p.stop_id))
        : [stopId];

      // Predicted path — bus/streetcar only; RT fetch failure is not fatal.
      if (stopDetail.mode !== "subway") {
        let updates;
        try {
          updates = await deps.rt.getTripUpdates();
        } catch {
          updates = undefined;
        }
        if (updates) {
          const { arrivals, truncated } = await predictedArrivals(
            deps.db, updates, targetStopIds, route_id, new Date(), cap,
          );
          if (arrivals.length > 0) {
            return ok({ stop: toStopSummary(stopDetail), arrivals, realtime_available: true, truncated });
          }
        }
      }

      // Scheduled fallback — subway, no live trips, or RT unavailable.
      const sched = await getSchedule(deps.db, {
        stopId,
        ...(routeIdNum !== undefined ? { routeId: routeIdNum } : {}),
        limit: cap,
      });
      if (!sched) {
        return errorResult("not_found", `No stop found with stop_id "${stop_id}".`);
      }
      const arrivals: Arrival[] = sched.departures.map((d) => ({
        route_id: d.route_id,
        ...(d.route_short_name !== undefined ? { route_short_name: d.route_short_name } : {}),
        headsign: d.headsign,
        direction_id: d.direction_id,
        time: d.scheduled_time,
        realtime: false,
        source: "scheduled" as const,
      }));
      return ok({
        stop: sched.stop,
        arrivals,
        realtime_available: false,
        truncated: sched.truncated,
        ...(sched.hint !== undefined ? { hint: sched.hint } : {}),
      });
    },
  );
}
```

- [ ] **Step 5: Register the tool**

In `src/server.ts`, add the import and the registration call (next to `registerGetVehicles`):

```ts
import { registerGetArrivals } from "./tools/get-arrivals.js";
```
```ts
  registerGetArrivals(server, deps);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/tools/get-arrivals.test.ts`
Expected: PASS (6 cases).

- [ ] **Step 7: Full check + commit**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
git add src/gtfs/schedule-repository.ts src/tools/get-arrivals.ts src/server.ts src/tools/get-arrivals.test.ts
git commit -m "feat(get_arrivals): unified live/scheduled arrivals tool (#11)"
```

---

## Post-implementation

- [ ] **Manual live check** (needs `data/ttc.db` + network): start the inspector (`npm run dev` + `npm run mcp-inspector`), call `get_arrivals` for a busy surface stop_id (e.g. from `search_stops`) and confirm `source: "predicted"` with near-future times; call a subway station id and confirm `source: "scheduled"`. See memory `ttc-mcp-local-run`.
- [ ] **Update `docs/spec/realtime-integration.md` §4** note that stop-id resolution uses the offline `rt_stop_crosswalk` (Dataset B), and `docs/spec/tool-schemas.md` §6 that `delay_seconds` is deferred to #33 (optional; keep spec honest).
- [ ] Open the PR referencing #11; note #33 (direction/headsign/`delay_seconds`) and #34 remain follow-ups.

## Self-review notes (author)

- **Spec coverage:** crosswalk (Task 1) ✓; Arrival DTO + predicted transform (Task 2) ✓; tool + subway/no-live/RT-failure fallback + station aggregation + `realtime_available` + Zod (Task 3) ✓; out-of-scope items tracked to #33/#34 ✓.
- **Type consistency:** `predictedArrivals` signature identical in Task 2 definition and Task 3 consumption; `toStopSummary` exported in Task 3 Step 1 before use; `Arrival.source` uses `as const` on both paths to satisfy the `z.enum` literal type.
- **Fixture dependency:** Tasks 2–3 rely on `rt_stop_crosswalk` existing in `applySchema` (Task 1) — tasks must run in order.
