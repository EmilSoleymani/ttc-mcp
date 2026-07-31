# `get_schedule` Gap Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two gaps in `get_schedule` found during manual testing of PR #23 — the `LIMIT 500` cap that drops the rest of the service day, and the dead station-aggregation path caused by missing `location_type`/`parent_station` data.

**Architecture:** Gap 1 is a self-contained change to the schedule query: push the `when` lower bound into SQL and fetch only the earliest `limit + 1` rows per candidate day (ordered by `dep`, using the existing `ix_st_stop_dep` index), replacing the blind cap. Gap 2 is an ingest-layer change: keep Dataset A as the base for `stops`, then enrich it with Dataset B's station hierarchy (`location_type`/`parent_station` on ~363 platforms + 114 station rows) via a transient staging table. The `get_schedule` tool, `stops-repository`, and all Zod schemas need no changes — they were already correct.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), libSQL (`@libsql/client`), Zod, vitest, `csv-parse`, `unzipper`. America/Toronto time handled by `src/gtfs/service-time.ts` via `Intl` (no tz library).

## Global Constraints

- Node `>=20`; ESM modules — **all relative imports use the `.js` extension** even for `.ts` files.
- No new runtime dependencies (the project deliberately carries no date/tz library).
- Absolute departure times are ISO 8601 with the America/Toronto offset (`-04:00` EDT / `-05:00` EST), produced by `toIsoWithTorontoOffset`.
- `limit` default 20, hard cap 20 (`DEFAULT_LIMIT` / `MAX_LIMIT` in `schedule-repository.ts`).
- Gates that must pass before done: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`.
- Commit style: conventional commits; end message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Branch: `feat/7-get-schedule` (already checked out). Do not branch or push unless asked.

---

## File Structure

- `src/gtfs/service-time.ts` — **modify**: add exported `secondsSinceServiceMidnight` (reuses private `midnightInstant`).
- `src/gtfs/service-time.test.ts` — **modify**: cover the new helper.
- `src/gtfs/schedule-repository.ts` — **modify**: windowed per-day fetch; remove `CANDIDATE_CEILING`.
- `src/gtfs/schedule-repository.test.ts` — **modify**: add a >`limit` late-in-day regression test.
- `src/gtfs/ingest.ts` — **modify**: add `enrichStationsFromDatasetB(client, bStops)`.
- `src/gtfs/station-enrich.test.ts` — **create**: unit test for the enrichment.
- `src/gtfs/run-ingest.ts` — **modify**: stream Dataset B's `stops.txt` into the enrichment, before transfers are built.

---

## Task 1: `secondsSinceServiceMidnight` helper (Gap 1)

**Files:**
- Modify: `src/gtfs/service-time.ts` (add export after `midnightInstant`)
- Test: `src/gtfs/service-time.test.ts`

**Interfaces:**
- Consumes: existing private `midnightInstant(date: ServiceDate): Date`, exported `ServiceDate`.
- Produces: `export function secondsSinceServiceMidnight(date: ServiceDate, instant: Date): number` — floor of seconds between `date`'s Toronto service-midnight and `instant`; negative when `instant` precedes that midnight. Used by Task 2 as an SQL `dep` lower bound.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` block in `src/gtfs/service-time.test.ts` (import the new symbol at the top alongside the others):

```ts
describe("secondsSinceServiceMidnight", () => {
  it("returns seconds since Toronto service-midnight for a same-day instant", () => {
    // 15:00 EDT is 54000s after 00:00 EDT on the same service date.
    const s = secondsSinceServiceMidnight(
      { year: 2026, month: 7, day: 24 },
      new Date("2026-07-24T15:00:00-04:00"),
    );
    expect(s).toBe(54000);
  });

  it("is negative when the instant precedes the service date's midnight (next-day window)", () => {
    // Service date 07-25, instant on 07-24 → before that midnight.
    const s = secondsSinceServiceMidnight(
      { year: 2026, month: 7, day: 25 },
      new Date("2026-07-24T15:00:00-04:00"),
    );
    expect(s).toBeLessThan(0);
  });

  it("exceeds 86400 for a prior service date's post-midnight window", () => {
    // Service date 07-23, instant 07-24T15:00 → 39h = 140400s.
    const s = secondsSinceServiceMidnight(
      { year: 2026, month: 7, day: 23 },
      new Date("2026-07-24T15:00:00-04:00"),
    );
    expect(s).toBe(140400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gtfs/service-time.test.ts`
Expected: FAIL — `secondsSinceServiceMidnight is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

In `src/gtfs/service-time.ts`, add immediately after the `midnightInstant` function:

```ts
/** Seconds after `date`'s America/Toronto service-midnight at which a GTFS
 * `dep` (seconds-since-midnight) is still at/after `instant`. Floored — a
 * safe lower bound to pair with an exact JS `absolute >= when` filter.
 * Negative when `instant` precedes the date's midnight (the +1-day window). */
export function secondsSinceServiceMidnight(
  date: ServiceDate,
  instant: Date,
): number {
  return Math.floor((instant.getTime() - midnightInstant(date).getTime()) / 1000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gtfs/service-time.test.ts`
Expected: PASS (all cases, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/gtfs/service-time.ts src/gtfs/service-time.test.ts
git commit -m "feat(schedule): add secondsSinceServiceMidnight helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Windowed per-day departure fetch (Gap 1)

**Files:**
- Modify: `src/gtfs/schedule-repository.ts` (`fetchDepartureRows`, `getSchedule`; remove `CANDIDATE_CEILING`)
- Test: `src/gtfs/schedule-repository.test.ts`

**Interfaces:**
- Consumes: `secondsSinceServiceMidnight` from Task 1 (add to the existing `service-time.js` import).
- Produces: unchanged public `getSchedule` signature/return type. Internal `fetchDepartureRows` gains `minDep: number` and `limit: number` params.

- [ ] **Step 1: Write the failing regression test**

Append inside the `describe("schedule repository", …)` block in `src/gtfs/schedule-repository.test.ts`:

```ts
it("returns tonight's remaining departures at a stop busier than the old cap", async () => {
  // Trip 700 on route 900 (service 1). Give stop 662 a full day of
  // departures: 600 in the morning (00:00–10:00) plus two in the evening.
  // The old LIMIT-500 fetch kept only the earliest 500 (all morning), so an
  // evening query wrongly returned the NEXT day. The windowed fetch must
  // return 20:00 TODAY.
  await client.execute({
    sql: `INSERT INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id, shape_id)
          VALUES (700, 900, 1, 'Loop', 0, NULL)`,
  });
  const rows: string[] = [];
  const args: number[] = [];
  for (let i = 0; i < 600; i++) {
    rows.push("(700, 662, 1, ?, ?)");
    args.push(i * 60, i * 60); // 00:00:00 .. 09:59:00
  }
  rows.push("(700, 662, 1, ?, ?)"); // 20:00:00
  args.push(72000, 72000);
  rows.push("(700, 662, 1, ?, ?)"); // 20:30:00
  args.push(73800, 73800);
  await client.execute({
    sql: `INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arr, dep) VALUES ${rows.join(", ")}`,
    args,
  });

  const result = await getSchedule(client, {
    stopId: 662,
    routeId: 900,
    when: new Date("2026-07-24T20:00:00-04:00"),
    limit: 5,
  });
  expect(result?.departures[0]?.scheduled_time).toMatch(/^2026-07-24T20:00/);
  expect(result?.truncated).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gtfs/schedule-repository.test.ts -t "busier than the old cap"`
Expected: FAIL — first departure is `2026-07-25T…` (next day) because the earliest-500 morning rows are fetched, then filtered out by the `>= when` check.

- [ ] **Step 3: Update `fetchDepartureRows`**

In `src/gtfs/schedule-repository.ts`, delete the `CANDIDATE_CEILING` constant and its comment, and change `fetchDepartureRows` to accept `minDep`/`limit` and window the SQL:

```ts
async function fetchDepartureRows(
  client: Client,
  stopIds: number[],
  serviceIds: number[],
  routeId: number | undefined,
  minDep: number,
  limit: number,
): Promise<RawDeparture[]> {
  if (stopIds.length === 0 || serviceIds.length === 0) return [];
  const stopPlaceholders = stopIds.map(() => "?").join(", ");
  const servicePlaceholders = serviceIds.map(() => "?").join(", ");
  const routeFilter = routeId !== undefined ? "AND t.route_id = ?" : "";
  const result = await client.execute({
    sql: `SELECT st.stop_id AS stop_id, st.dep AS dep, t.route_id AS route_id,
                 t.trip_headsign AS trip_headsign, t.direction_id AS direction_id,
                 r.route_short_name AS route_short_name
          FROM stop_times st
          JOIN trips t ON t.trip_id = st.trip_id
          JOIN routes r ON r.route_id = t.route_id
          WHERE st.stop_id IN (${stopPlaceholders})
            AND t.service_id IN (${servicePlaceholders})
            AND st.dep IS NOT NULL
            AND st.dep >= ?
            ${routeFilter}
          ORDER BY st.dep
          LIMIT ?`,
    args: [
      ...stopIds,
      ...serviceIds,
      minDep,
      ...(routeId !== undefined ? [routeId] : []),
      limit,
    ],
  });
  return result.rows.map((row) => ({
    stop_id: Number(row.stop_id),
    dep: Number(row.dep),
    route_id: Number(row.route_id),
    route_short_name:
      row.route_short_name === null ? null : asText(row.route_short_name),
    trip_headsign:
      row.trip_headsign === null ? null : asText(row.trip_headsign),
    direction_id: row.direction_id === null ? null : Number(row.direction_id),
  }));
}
```

Note the bind order: `stopIds`, `serviceIds`, `minDep`, then the optional `routeId`, then `limit` — matching the `?` order in the SQL (`minDep` before the trailing `routeFilter`, `limit` last).

- [ ] **Step 4: Update `getSchedule` to resolve `limit` first and pass the window**

In `getSchedule`, move the `limit` resolution above the candidate-day loop and pass `minDep`/`limit + 1` into the fetch. Replace the loop body:

```ts
  const when = params.when ?? new Date();
  const today = serviceDateAt(when);
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const withAbsolute: { row: RawDeparture; absolute: Date }[] = [];
  for (const offset of CANDIDATE_DAY_OFFSETS) {
    const date = addDays(today, offset);
    const serviceIds = await activeServiceIds(client, date);
    if (serviceIds.length === 0) continue;
    const minDep = Math.max(0, secondsSinceServiceMidnight(date, when));
    const rows = await fetchDepartureRows(
      client,
      platformIds,
      serviceIds,
      params.routeId,
      minDep,
      limit + 1,
    );
    for (const row of rows) {
      const absolute = absoluteTimeFor(date, row.dep);
      if (absolute.getTime() >= when.getTime()) {
        withAbsolute.push({ row, absolute });
      }
    }
  }
  withAbsolute.sort((a, b) => a.absolute.getTime() - b.absolute.getTime());
```

Then delete the now-duplicate `const limit = Math.min(...)` line that previously sat just below the sort (keep the single declaration added above). The subsequent `truncated`/`departures`/`slice` block stays exactly as-is. Add `secondsSinceServiceMidnight` to the import from `./service-time.js`.

- [ ] **Step 5: Run the regression test + full repository suite**

Run: `npx vitest run src/gtfs/schedule-repository.test.ts`
Expected: PASS — the new test and all 9 existing tests (surface stop, station aggregation, route filter, cap+hint, hint omission, past-24:00, calendar_dates add/remove, unknown stop).

- [ ] **Step 6: Commit**

```bash
git add src/gtfs/schedule-repository.ts src/gtfs/schedule-repository.test.ts
git commit -m "fix(schedule): window next-N fetch by when instead of a blind LIMIT 500

The 500-row cap with no ORDER BY returned the earliest 500 departures of
the day (index order), so busy stops queried after that cutoff dropped the
rest of today and jumped to tomorrow. Fetch only the earliest limit+1 rows
at/after the when threshold per candidate day.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `enrichStationsFromDatasetB` (Gap 2 core)

**Files:**
- Modify: `src/gtfs/ingest.ts` (add exported function; reuse the existing `stops` `TableSpec`)
- Test: `src/gtfs/station-enrich.test.ts` (create)

**Interfaces:**
- Consumes: `loadTable`, `TABLE_SPECS`, `CsvRow` (already in `ingest.ts`); `Client` from `@libsql/client`.
- Produces: `export async function enrichStationsFromDatasetB(client: Client, bStops: AsyncIterable<CsvRow>): Promise<{ platformsLinked: number; stationsInserted: number }>`. Called by Task 4.

- [ ] **Step 1: Write the failing test**

Create `src/gtfs/station-enrich.test.ts`:

```ts
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
        { stop_id: "16073", stop_code: "16073", stop_name: "Eglinton EB Platform", stop_lat: "43.7", stop_lon: "-79.4", parent_station: "", location_type: "" },
        { stop_id: "662", stop_code: "662", stop_name: "Danforth at Kennedy", stop_lat: "43.7", stop_lon: "-79.2", parent_station: "", location_type: "" },
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
        { stop_id: "99993", stop_code: "16999", stop_name: "Eglinton", stop_lat: "43.7", stop_lon: "-79.4", parent_station: "", location_type: "1" },
        { stop_id: "16073", stop_code: "16073", stop_name: "Eglinton EB Platform", stop_lat: "43.7", stop_lon: "-79.4", parent_station: "99993", location_type: "0" },
        { stop_id: "662", stop_code: "662", stop_name: "Danforth at Kennedy", stop_lat: "43.7", stop_lon: "-79.2", parent_station: "", location_type: "0" },
      ]),
    );

    expect(result).toEqual({ platformsLinked: 2, stationsInserted: 1 });

    const platform = await client.execute({
      sql: "SELECT parent_station, location_type FROM stops WHERE stop_id = 16073",
    });
    expect(Number(platform.rows[0].parent_station)).toBe(99993);
    expect(Number(platform.rows[0].location_type)).toBe(0);

    const station = await client.execute({
      sql: "SELECT location_type, stop_name FROM stops WHERE stop_id = 99993",
    });
    expect(Number(station.rows[0].location_type)).toBe(1);
    expect(station.rows[0].stop_name).toBe("Eglinton");

    // Staging table is transient — gone after enrichment.
    await expect(
      client.execute("SELECT 1 FROM stops_b LIMIT 1"),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gtfs/station-enrich.test.ts`
Expected: FAIL — `enrichStationsFromDatasetB is not exported` / import error.

- [ ] **Step 3: Implement the enrichment**

Add to `src/gtfs/ingest.ts` (after the `TABLE_SPECS`/`MERGED_TABLE_SPECS` definitions; it reuses the `stops` spec so it must appear after `TABLE_SPECS`):

```ts
/**
 * Overlays Dataset B's station hierarchy onto the Dataset-A `stops` table.
 * Dataset A leaves location_type/parent_station empty; Dataset B carries the
 * full model and its platform rows reuse Dataset A's stop_ids. Streams B's
 * stops into a transient `stops_b` table, links matching platforms
 * (UPDATE), inserts the location_type=1 station parent rows Dataset A lacks
 * (INSERT), then drops the staging table. Returns affected-row counts.
 */
export async function enrichStationsFromDatasetB(
  client: Client,
  bStops: AsyncIterable<CsvRow>,
): Promise<{ platformsLinked: number; stationsInserted: number }> {
  const stopsSpec = TABLE_SPECS.find((s) => s.table === "stops");
  if (!stopsSpec) throw new Error("stops spec missing");

  await client.execute("DROP TABLE IF EXISTS stops_b");
  await client.execute(
    `CREATE TABLE stops_b (
       stop_id INTEGER PRIMARY KEY, stop_code INTEGER, stop_name TEXT,
       stop_lat REAL, stop_lon REAL, parent_station INTEGER, location_type INTEGER
     )`,
  );
  await loadTable(client, { ...stopsSpec, table: "stops_b" }, bStops);

  const linked = await client.execute(
    `UPDATE stops
        SET location_type =
              (SELECT b.location_type FROM stops_b b WHERE b.stop_id = stops.stop_id),
            parent_station =
              (SELECT b.parent_station FROM stops_b b WHERE b.stop_id = stops.stop_id)
      WHERE stop_id IN (SELECT stop_id FROM stops_b)`,
  );
  const inserted = await client.execute(
    `INSERT INTO stops (stop_id, stop_code, stop_name, stop_lat, stop_lon, parent_station, location_type)
     SELECT stop_id, stop_code, stop_name, stop_lat, stop_lon, parent_station, location_type
       FROM stops_b
      WHERE location_type = 1
        AND stop_id NOT IN (SELECT stop_id FROM stops)`,
  );

  await client.execute("DROP TABLE IF EXISTS stops_b");
  return {
    platformsLinked: Number(linked.rowsAffected),
    stationsInserted: Number(inserted.rowsAffected),
  };
}
```

Add `import { type Client } from "@libsql/client";` if `Client` is not already imported in `ingest.ts` (it currently imports `type InValue`; extend the existing import to `import { type Client, type InValue } from "@libsql/client";`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gtfs/station-enrich.test.ts`
Expected: PASS — `{ platformsLinked: 2, stationsInserted: 1 }`, platform 16073 linked to 99993, station 99993 present as `location_type=1`, `stops_b` dropped.

- [ ] **Step 5: Commit**

```bash
git add src/gtfs/ingest.ts src/gtfs/station-enrich.test.ts
git commit -m "feat(ingest): enrich stops with Dataset B station hierarchy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire enrichment into the ingest pipeline (Gap 2 orchestration)

**Files:**
- Modify: `src/gtfs/run-ingest.ts` (`runIngest`, after both zips load, before transfers)

**Interfaces:**
- Consumes: `enrichStationsFromDatasetB` from Task 3; existing `parsedRecords`, `unzipper`, `mergedZipPath` in `run-ingest.ts`.
- Produces: enriched `stops` table at ingest time; adds `stops_enriched`/`stations_added` to the returned `counts`.

> **No unit gate:** `runIngest` is IO orchestration, verified by the real ingest run and the fast-path/manual checks in Task 5 (matching the module's existing "verified by the real ingest run, not the unit gate" posture). Its deliverable is validated in Task 5.

- [ ] **Step 1: Add `enrichStationsFromDatasetB` to the ingest import**

In `src/gtfs/run-ingest.ts`, extend the existing `./ingest.js` import to include `enrichStationsFromDatasetB`.

- [ ] **Step 2: Stream Dataset B's `stops.txt` into the enrichment**

In `runIngest`, immediately after `await loadZip(mergedZipPath, MERGED_TABLE_SPECS, client, counts);` and before the `const [stops, pathways] = await Promise.all([...])` transfers block, insert:

```ts
    // Overlay Dataset B's station hierarchy (location_type/parent_station)
    // onto the Dataset-A stops — Dataset A leaves those columns empty.
    const mergedDir = await unzipper.Open.file(mergedZipPath);
    const bStopsEntry = mergedDir.files.find((f) => f.path === "stops.txt");
    if (!bStopsEntry) {
      throw new Error("Dataset B feed is missing stops.txt");
    }
    const enriched = await enrichStationsFromDatasetB(
      client,
      parsedRecords(bStopsEntry.stream()),
    );
    counts.stops_enriched = enriched.platformsLinked;
    counts.stations_added = enriched.stationsInserted;
```

- [ ] **Step 3: Typecheck + lint the change**

Run: `npm run typecheck && npm run lint`
Expected: PASS (no type or lint errors in `run-ingest.ts`).

- [ ] **Step 4: Commit**

```bash
git add src/gtfs/run-ingest.ts
git commit -m "feat(ingest): overlay Dataset B station hierarchy during ingest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: End-to-end verification (both gaps)

**Files:** none (verification only). Uses the running HTTP server (`http://localhost:3000/mcp`) and MCP Inspector (`http://localhost:6274`).

- [ ] **Step 1: Full unit gates**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: all PASS. (If `format:check` flags anything, run `npm run format`, review, and amend the relevant commit.)

- [ ] **Step 2: Fast-path — apply the enrichment to the live local DB**

Rather than a full ~10-min re-ingest, apply the same enrichment to the existing `data/ttc.db` using Dataset B's already-downloaded `stops.txt`, then confirm station rows exist:

```bash
npx tsx -e '
import { createClient } from "@libsql/client";
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import { enrichStationsFromDatasetB } from "./src/gtfs/ingest.ts";
const c = createClient({ url: "file:./data/ttc.db" });
const recs = createReadStream("/private/tmp/claude-501/-Users-emil-Documents-Personal-ttc-mcp/03521274-2a2f-4a43-9058-673fd3092d4d/scratchpad/stops.txt").pipe(parse({ columns: true, skip_empty_lines: true, bom: true }));
console.log(await enrichStationsFromDatasetB(c, recs));
const r = await c.execute("SELECT COUNT(*) n FROM stops WHERE location_type = 1");
console.log("stations:", r.rows[0].n);
c.close();
'
```
Expected: `{ platformsLinked: ~363, stationsInserted: ~114 }`; `stations: ~114`. (If `scratchpad/stops.txt` is gone, re-extract it from `scratchpad/dsB.zip` with `unzip -o dsB.zip stops.txt`.)

- [ ] **Step 3: Restart the dev server against the enriched DB**

The `tsx watch` server reloads on file change, but the DB was mutated out-of-band. Restart the `npm run dev` process so its libSQL client sees the new rows. Confirm health: `curl -s http://localhost:3000/health` → `{"status":"ok"}`.

- [ ] **Step 4: Gap 2 manual check — station aggregation**

In MCP Inspector (or via curl), call `get_schedule` on Eglinton station `99993` with a daytime `when`:
`{"stop_id":"99993","when":"2026-07-30T12:00:00-04:00","limit":6}`
Expected: `stop.is_station: true`; departures from **multiple** platforms, each carrying a distinct `platform_stop_id`.
Also confirm a plain bus stop still omits `platform_stop_id`: `{"stop_id":"16746"}`.

- [ ] **Step 5: Gap 1 manual check — busy stop after the old cutoff**

Call `{"stop_id":"16746","when":"2026-07-30T15:00:00-04:00"}` (no `route_id`).
Expected: first departure is `2026-07-30T15:…` (tonight), **not** `2026-07-31T…`. Cross-check it matches the `route_id:"89"` result from earlier testing.

- [ ] **Step 6: Final full re-ingest (authoritative validation)**

Run: `npm run ingest`
Expected: completes without error; `counts` includes non-zero `stops_enriched` and `stations_added`. Re-run Steps 4–5 against the freshly rebuilt DB to confirm both fixes hold end-to-end on real data.

- [ ] **Step 7: Update the PR testing notes**

The PR #23 "MANUAL LOCAL TESTING PLAN" step 4 referenced a `location_type=1` station that didn't exist pre-fix. Leave a brief note in the PR description (or a follow-up comment) that station aggregation is now backed by Dataset B enrichment, using Eglinton `99993` as the worked example.

---

## Self-Review

**Spec coverage:**
- Gap 1 root cause + fix (helper, windowed fetch, truncated via +1) → Tasks 1–2. ✅
- Gap 1 edge cases (exact-time, −1-day post-midnight, DST, floor off-by-one) → covered by the `absolute >= when` JS filter retained in Task 2 Step 4 + existing past-24:00 test. ✅
- Gap 2 enrichment (staging load, UPDATE platforms, INSERT stations, DROP) → Task 3. ✅
- Gap 2 wiring before transfers → Task 4. ✅
- Verification (fast-path + manual + full ingest) → Task 5. ✅
- Design note: the staging table is created/dropped **inside** `enrichStationsFromDatasetB` rather than declared in `schema.ts` (transient, keeps the shipped schema clean) — a deliberate refinement of the design doc's "add to schema.ts". ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases" — all steps carry concrete code or exact commands. ✅

**Type consistency:** `secondsSinceServiceMidnight(date: ServiceDate, instant: Date): number` defined in Task 1, consumed identically in Task 2. `enrichStationsFromDatasetB(client, bStops) → { platformsLinked, stationsInserted }` defined in Task 3, consumed with the same shape in Task 4 and asserted in Task 3's test. `fetchDepartureRows` bind order documented to match the `?` order. ✅
