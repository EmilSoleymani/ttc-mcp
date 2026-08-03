# `get_arrivals` — unified live predictions + scheduled fallback

**Issue:** #11. **Depends on:** #7 (`get_schedule`), #8 (GTFS-RT foundation), #9 (trip-join units).
**Spec refs:** [`docs/spec/realtime-integration.md`](../../spec/realtime-integration.md) §3–4, [`docs/spec/tool-schemas.md`](../../spec/tool-schemas.md) §6.
**Follow-ups:** #33 (direction/headsign + `delay_seconds`), #34 (namespace-matched data source — not needed for stop coverage, see below).

## Goal

Implement the unified `get_arrivals` MCP tool: live predicted arrival times at a stop for bus/streetcar, transparently falling back to scheduled times for subway stops or any stop with no live trips in the window. Always answers.

**Contract (fixed by tool-schemas §6):**

```
get_arrivals { stop_id, route_id?, limit? }
  -> { stop: StopSummary, arrivals: Arrival[], realtime_available: boolean, truncated: boolean, hint? }

Arrival { route_id, route_short_name?, headsign, direction_id,
          time, realtime: boolean, source: "predicted" | "scheduled", delay_seconds? }
```

Envelope mirrors `get_schedule` (`{ stop, <items>, truncated, hint?, error? }`).

## Background: the two join problems (from #9 / PR #31 measurement)

Against the live TTC feed, RT identifiers do **not** all share the ingested static namespace:

- **`trip_id`: 0%, unrecoverable.** TripUpdates are `scheduleRelationship: NEW` synthetic trips with `directionId` pinned to `0` and no `startDate`/`startTime`. `resolveArrivalIdentity` will therefore almost always take its `matched: false` branch. **Consequence:** no `direction_id`/`headsign`/`delay_seconds` from a trip join in this slice — deferred to #33.
- **`route_id`: 99%.** RT `trip.routeId` equals the static `route_id`, which for all 233 routes also equals `route_short_name`. So one lookup gives both the filter key and `route_short_name`.
- **`stop_id`: ~59% direct, but ~100% via a crosswalk.** RT `stopTimeUpdate.stopId` matches the ingested (Dataset A) `stop_id` only ~59%, but matches **Dataset B**'s `stop_id` at **99.8%**, and `B.stop_code == A.stop_id`. Since ingest already downloads Dataset B, we can build an offline crosswalk with ~100% coverage and **no external dependency / API key** (this is why #34 is not required for stop coverage). Measured end-to-end: 8268/8282 live stops bridged, each to exactly one static stop.

## Components

### 1. Stop crosswalk (ingest-time table) — new infrastructure

**Schema** (`src/gtfs/schema.ts`): a new table

```sql
CREATE TABLE rt_stop_crosswalk (
  rt_stop_id INTEGER PRIMARY KEY,   -- GTFS-RT stopTimeUpdate.stopId (== Dataset B stop_id)
  stop_id    INTEGER NOT NULL       -- ingested (Dataset A) stop_id
);
CREATE INDEX ix_rt_stop_crosswalk_stop ON rt_stop_crosswalk(stop_id);
```

**Population** (`src/gtfs/ingest.ts`): built during the existing Dataset B enrichment step (`enrichStationsFromDatasetB`), which already streams Dataset B `stops.txt` into a transient `stops_b(stop_id, stop_code, …)` table. Before that table is dropped, populate the crosswalk by joining it to the loaded Dataset A `stops` on the shared public code:

```sql
INSERT INTO rt_stop_crosswalk (rt_stop_id, stop_id)
SELECT b.stop_id, s.stop_id
FROM stops_b b JOIN stops s ON s.stop_code = b.stop_code;
```

Joining through `stops` (rather than trusting `B.stop_code` blindly) guarantees every crosswalk row points at a stop that actually exists in the ingested catalog. Rows where a Dataset B stop has no matching Dataset A `stop_code` are simply absent (the ~0.2% tail) — those RT stops fall back to scheduled, same as any unmapped stop.

### 2. Arrival schema — `src/schemas/arrival.ts` (new)

```ts
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
  limit: z.number().int().positive().max(20).optional()
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

### 3. Arrivals repository — `src/gtfs-rt/arrivals-repository.ts` (new)

Pure-ish transform, given a decoded TripUpdates feed + DB client + the resolved target static stop_ids. Reuses `toTorontoIso` (vehicles-repository) and the #9 units (`parseRtTripId`, `getStaticTripById`, `resolveArrivalIdentity`).

```ts
async function predictedArrivals(
  client: Client,
  tripUpdates: transit_realtime.ITripUpdate[],
  targetStopIds: number[],          // queried stop, or a station's platform ids
  routeId: string | undefined,      // filter, compared to RT trip.routeId
  now: Date,
  limit: number,
): Promise<{ arrivals: Arrival[]; truncated: boolean }>
```

Algorithm:

1. **Resolve target rt_stop_ids.** `SELECT rt_stop_id, stop_id FROM rt_stop_crosswalk WHERE stop_id IN (targets)`. Build `rtStopId -> staticStopId`. (Empty ⇒ no predicted arrivals ⇒ caller falls back to scheduled.)
2. **Collect predictions.** Walk each `tripUpdate.stopTimeUpdate`; keep those whose `stopId` is a target rt_stop_id. Predicted epoch = `arrival.time ?? departure.time`; skip if missing or `< now`. Record `{ trip: update.trip, epoch }`.
3. **Route filter** (cheap, pre-enrichment): if `routeId` set, keep only `trip.routeId === routeId` (consistent with `get_vehicles`).
4. **Sort** by epoch ascending; slice to `limit + 1` to detect truncation; enrich only the kept set (≤ limit + 1 — bounds DB work).
5. **Enrich each:** `identity = resolveArrivalIdentity(trip, await getStaticTripById(client, parseRtTripId(trip.tripId)))`. Skip if `undefined` (no usable route at all — never-drop's single drop case). `route_short_name` = `identity.route_short_name` when the (rare) matched branch set it, else a routes lookup by `identity.route_id` (`route_id == route_short_name`) so the unmatched-but-real-route case still gets a label; omitted if the route_id isn't in the catalog (e.g. the `"600"` orphan). Emit:
   ```
   { route_id, route_short_name?, headsign: identity.headsign, direction_id: identity.direction_id,
     time: toTorontoIso(epoch), realtime: true, source: "predicted" }
   ```
   `delay_seconds` omitted (deferred to #33).
6. Return `{ arrivals: sliced-to-limit, truncated: kept > limit }`.

> Note: because `trip_id` is 0%, `getStaticTripById` almost always misses. Enriching only the ≤ `limit+1` post-sort set keeps that to ≤21 lookups per call; acceptable, and the branch stays correct if TTC ever emits joinable trip_ids.

### 4. Tool handler — `src/tools/get-arrivals.ts` (new)

Mirrors `get-schedule.ts` structure (`errorResult` helper, numeric-string validation, DTO shaped identically for success and error).

```
1. Validate stop_id (numeric string) and route_id (if present) → invalid_argument on failure.
2. stop = getStopById(stop_id). Missing → not_found.
3. targetStopIds = stop.is_station ? platform stop_ids : [stop_id]   (same expansion as getSchedule).
4. If stop.mode !== "subway":
     tripUpdates = rt.getTripUpdates()   // try/catch → on failure, skip to scheduled (don't hard-error)
     { arrivals, truncated } = predictedArrivals(db, tripUpdates, targetStopIds, route_id, now, limit)
     if arrivals.length > 0:
        return { stop: summary, arrivals, realtime_available: true, truncated }
5. Fallback (subway, no predictions, or RT fetch failed):
     sched = getSchedule(db, { stopId, routeId?, limit })
     arrivals = sched.departures.map(d => ({ ...d without scheduled_time/platform_stop_id,
                 time: d.scheduled_time, realtime: false, source: "scheduled" }))
     return { stop: sched.stop, arrivals, realtime_available: false, truncated: sched.truncated, hint?: sched.hint }
```

**Mix policy (decided):** predicted-only when a stop has *any* live prediction; all-scheduled only when it has none. No merging of scheduled entries into a predicted result (without `trip_id` the two can't be de-duplicated safely). A route that happens to have no live vehicle right now is simply absent from a predicted result until it appears.

**Station aggregation:** platform expansion reuses `getSchedule`'s logic; predicted arrivals across a station's platforms are gathered into one flat list sorted by time. Subway station platforms won't appear in the RT feed, so a subway station naturally lands in the scheduled fallback.

**Output shape (decided):** flat `Arrival[]` sorted by time, consistent with `get_schedule` — not nested by direction. `direction_id` rides on each arrival (meaningful once #33 lands).

### 5. Registration — `src/server.ts`

`registerGetArrivals(server, deps)` alongside the others; `deps` already carries `db` + `rt`.

## Error handling

- **invalid_argument** — non-numeric `stop_id`/`route_id`.
- **not_found** — no stop with that `stop_id`.
- **RT fetch failure** — *not* a hard error: fall through to the scheduled path so the tool still answers (`realtime_available: false`). (Contrast `get_vehicles`, which has no scheduled fallback and so surfaces `upstream_unavailable`.)
- **never-drop** — an arrival is dropped only when `resolveArrivalIdentity` returns `undefined` (no route to attribute it to at all); a failed `trip_id` join never drops.

## Testing

- **`arrivals-repository.test.ts`** — fixture TripUpdates feed (extend `src/gtfs-rt/test-support.ts`) + in-memory libSQL seeded with a small `stops` / `routes` / `rt_stop_crosswalk` / `trips` set. Cases: crosswalked stop match; past times filtered; route filter; sort + `limit`/`truncated`; RT-only fallback identity (unmatched trip_id → `route_short_name` from routes lookup, `headsign:""`, `direction_id:0`); station multi-platform gather; empty result when no crosswalk row.
- **`get-arrivals.test.ts`** — tool-level: predicted path; subway → scheduled; no-RT-in-window → scheduled; RT fetch throws → scheduled; invalid args; not_found; `realtime_available` correctness; DTO Zod-validates.
- **Ingest crosswalk test** — after ingest of a tiny Dataset A + Dataset B fixture, `rt_stop_crosswalk` maps `B.stop_id -> A.stop_id` via shared `stop_code`.
- All existing checks stay green: `npm run typecheck && lint && format:check && test && build`. Manual live check via the inspector against a known busy surface stop once implemented.

## Explicitly out of scope (tracked elsewhere)

- **`direction_id`, `headsign`, `delay_seconds`** beyond what RT provides → **#33** (stop-sequence pattern match recovers the static trip, which yields all three together).
- **Namespace-matched RT data source / BusTime key** → **#34** (not needed here; the offline crosswalk gives ~100% stop coverage).

## Acceptance criteria (from #11)

- [ ] Bus/streetcar arrivals return real predicted times (`source: "predicted"`).
- [ ] Subway / no-live stops fall back to scheduled (`realtime: false`, `source: "scheduled"`).
- [ ] `realtime_available` reflects whether any RT prediction was found.
- [ ] Station aggregation across platforms; Zod-validated; tested.
- [ ] Offline `rt_stop_crosswalk` built at ingest; predicted stop coverage measured ~100% on the live feed.
