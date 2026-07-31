# Design: `get_schedule` gap fixes — bounded next-N query + station enrichment

**Date:** 2026-07-30
**Branch:** `feat/7-get-schedule` (PR #23)
**Status:** approved design, pre-implementation

Two gaps found during manual testing of PR #23 are fixed together on this branch.

---

## Gap 1 — `LIMIT 500` cap silently drops the rest of the service day

### Root cause

`fetchDepartureRows` in `src/gtfs/schedule-repository.ts` fetches candidate rows with
`LIMIT 500` (`CANDIDATE_CEILING`) and **no lower bound on `st.dep`** and **no `ORDER BY`**.
The query plan uses index `ix_st_stop_dep (stop_id, dep)`, so rows come back
earliest-`dep`-first; the cap therefore keeps only the earliest 500 departures of the day.
The `when` filter is applied in JavaScript *after* truncation, so any departure past the
500th-earliest is unrecoverable.

For any stop with > 500 daily departures (e.g. stop `16746` has 1123 today; the 500th is at
14:32), a query at any time after that cutoff returns **tomorrow's** schedule instead of the
remaining departures today. Late-night / owl departures (the last of the service day) are the
first casualties on busy stops.

Reproduction (against local `data/ttc.db`, clock 2026-07-30):
- `get_schedule {stop_id:"16746", when:"2026-07-30T15:00:00-04:00"}` → first departure `07-31T04:55` ❌
- same query **+ `route_id:"89"`** (fits under the cap) → first departure `07-30T15:00` ✅

### Fix

Push the `when` lower bound into SQL and fetch only the earliest `limit + 1` qualifying rows
per candidate day, ordered by `dep` — using the existing index. No blind cap, no full-day scan.

**`src/gtfs/service-time.ts`** — add an exported helper that reuses the existing private
`midnightInstant`:

```ts
/** Seconds after `date`'s Toronto service-midnight at which a GTFS `dep`
 *  is still at/after `instant`. Floor — pair with an exact JS filter. */
export function secondsSinceServiceMidnight(date: ServiceDate, instant: Date): number {
  return Math.floor((instant.getTime() - midnightInstant(date).getTime()) / 1000);
}
```

For the three candidate days around `when`'s service date this yields: a large value for the
`when` day (today's time-of-day in seconds), `≤ 0` for the `+1` day (clamped to `0`), and a
value `≥ 86400` for the `−1` day (so only its post-midnight tail is fetched).

**`src/gtfs/schedule-repository.ts`**
- `fetchDepartureRows` gains parameters `minDep: number` and `limit: number`; the SQL gains
  `AND st.dep >= ?` and `ORDER BY st.dep LIMIT ?` (bind `limit + 1`). `CANDIDATE_CEILING` is
  removed.
- In `getSchedule`, per candidate day: compute
  `minDep = Math.max(0, secondsSinceServiceMidnight(date, when))`, fetch `limit + 1` rows,
  keep the existing exact JS filter `absolute.getTime() >= when.getTime()` (belt-and-suspenders
  against the floor’s ≤ 1s permissiveness), and collect.
- After merging the ≤ `3·(limit + 1)` rows and sorting by absolute time:
  `truncated = withAbsolute.length > limit`; `departures = slice(0, limit)`. The per-day `+1`
  is exactly what makes `truncated` accurate. `hint` logic is unchanged (present only when
  `truncated && routeId === undefined`).

`limit` is resolved (default 20, cap 20) **before** the day loop so the fetch uses it.

### Edge cases
- **Exactly at a departure time:** `dep >= when` — included (unchanged).
- **Post-midnight tail of the `−1` day:** the `≥ 86400` threshold fetches the `25:xx:00` trips
  belonging to yesterday's `service_id`; already-verified resolution to next-day `01:xx-04:00`
  is preserved.
- **DST:** thresholds come from `midnightInstant`, which is DST-correct; unaffected.
- **Off-by-one-second (floor):** an extra fetched row is removed by the exact JS filter; the
  `+1` headroom absorbs it. Accepted.

---

## Gap 2 — station aggregation / `platform_stop_id` is dead on real TTC data

### Root cause

`is_station` is `row.location_type === 1`, but the ingested Dataset A ("TTC Routes and
Schedules") `stops.txt` leaves `location_type` and `parent_station` **empty for all 9361
stops**. The ingest maps the columns correctly (`ingest.ts:93-101`), so the source simply does
not populate them. Result: `is_station` is always false, `get_schedule`'s station-aggregation
branch never runs, and `platform_stop_id` is never emitted. `buildStationTransfers` (which
groups by `parent_station`) has likewise been producing zero station transfers.

### Key finding

Dataset B (`completegtfs.zip`, already downloaded for `pathways`/`levels`) is a complete GTFS
feed whose `stops.txt` **does** carry the station hierarchy — 114 stations (`location_type=1`),
244 entrances (2), 2097 boarding areas (3) — and its **platform rows reuse Dataset A's
`stop_id`s**. Example: platform `16073` ("Eglinton … Eastbound Platform", referenced by
`stop_times`) has `parent_station = 99993` ("Eglinton", `location_type=1`) in Dataset B.

Coverage against Dataset A's served stops: **363** platforms gain a `parent_station`; **114**
station parent rows need inserting. (Only 60% of A's stops appear in B overall — expected, as A
is 6-week-fresh and B is quarterly — but the station-bearing 363 are covered.) Station ids live
in the ~99 8xx–99 9xx range, disjoint from A's stop_ids (verified during implementation).

### Fix — enrich in the ingest, keep Dataset A as base

`stops` stays sourced from Dataset A (it has all served stops + freshest data). After both zips
load and before transfers are built, add an enrichment step keyed on Dataset B's `stops.txt`:

**`src/gtfs/ingest.ts`** — add a staging `TableSpec` for B's `stops.txt` → a `stops_b` table
carrying at least `stop_id, stop_code, stop_name, stop_lat, stop_lon, parent_station,
location_type` (reuses `loadTable`).

**`src/gtfs/schema.ts`** — add the `stops_b` staging table (temporary; dropped after use).

**`src/gtfs/run-ingest.ts`** — between the Dataset B load and the transfers build:
1. Load B's `stops.txt` into `stops_b` (new spec).
2. `UPDATE stops SET location_type = (…), parent_station = (…)` from `stops_b` joined on
   `stop_id` — populates the ~363 platforms.
3. `INSERT INTO stops (…) SELECT … FROM stops_b WHERE location_type = 1 AND stop_id NOT IN
   (SELECT stop_id FROM stops)` — adds the 114 station rows.
4. `DROP TABLE stops_b`.
5. Build transfers as before — `buildStationTransfers` now emits real station links.

Scope is intentionally minimal (YAGNI): only `location_type = 1` stations and platform
`parent_station` links. Entrances (2) and boarding areas (3) are **not** ingested —
`get_schedule` does not need them. `get_schedule.ts`, `stops-repository.ts`, and the schemas
need **no changes**; the query/aggregation code was already correct, only starved of data.

### Verification without a full re-ingest

The shipped change is the ingest code, validated by a final full `npm run ingest`. For fast
iteration, the same enrichment SQL is applied to the existing local `data/ttc.db` (using B's
already-downloaded `stops.txt`) and `get_schedule` is exercised on a real station
(e.g. Eglinton `99993`) against the running HTTP server, confirming multi-platform departures
each tagged with `platform_stop_id`.

---

## Testing

**Unit (vitest):**
- `service-time.test.ts` — `secondsSinceServiceMidnight` for today / `+1` (clamped to 0) /
  `−1` (post-midnight ≥ 86400), across an EDT date.
- `schedule-repository.test.ts` — **regression for Gap 1**: a fixture stop with more
  departures than `limit`, queried mid-day, returns that day's *next* departures (not the next
  day's); `truncated` true with a full day ahead, false when the window is exhausted; owl tail
  still surfaces. Existing station-aggregation fixtures already assert `platform_stop_id` — keep
  them green (they exercise the now-fed code path).
- Ingest enrichment — a small fixture with an A stop that gains a parent and a B-only station
  that gets inserted; assert `stops` post-state and that `stops_b` is dropped.

**Manual (MCP Inspector, `http://localhost:6274` → `http://localhost:3000/mcp`):**
- Gap 1: busy stop (`16746`) at `when` after the old cutoff → tonight's departures, not
  tomorrow's.
- Gap 2 (post-enrichment): station `99993` (Eglinton) → departures across platforms, each with
  `platform_stop_id`; a plain bus stop still returns no `platform_stop_id`.

**Gates:** `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` all pass;
final `npm run ingest` succeeds and re-verifies both gaps end-to-end.
