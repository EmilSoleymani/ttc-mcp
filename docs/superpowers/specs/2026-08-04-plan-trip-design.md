# `plan_trip` — Multi-modal Transfer Routing (design)

**Issue:** #12 (capstone). **Depends on:** #5 (synthetic `transfers` table), #7
(`get_schedule` service-day machinery). **Both closed.**
**Spec refs:** [ADR 0001](../../adr/0001-plan-trip-sql-schedule-walking.md),
[ADR 0002](../../adr/0002-plan-trip-candidates-dto-and-pattern-key.md),
[`docs/spec/plan-trip.md`](../../spec/plan-trip.md),
[`docs/spec/tool-schemas.md`](../../spec/tool-schemas.md).

This design was pinned in a grilling/domain-modeling session (2026-08-04); the
ubiquitous language is in [`CONTEXT.md`](../../../CONTEXT.md).

## Goal

Implement `plan_trip`: a bounded RAPTOR-lite schedule-walker over the Turso
query layer that plans multi-modal (subway/streetcar/bus) journeys with
transfers, honouring `max_transfers`, `arrive_by` (emulated), and `modes`.
Ambiguous endpoints return `candidates` (success). Ships the `plan_a_trip`
prompt. Static schedule only (v1).

```
plan_trip { from, to, when?, arrive_by?, max_transfers?, modes?, max_itineraries? }
  -> { from: StopSummary | null, to: StopSummary | null,
       itineraries: Itinerary[],
       candidates?: { endpoint: "from" | "to", matches: StopSummary[] },
       error? }

Itinerary { depart_time, arrive_time, duration_seconds, transfers, legs: Leg[] }
Leg (transit)  { type:"transit", mode, route_id, route_short_name?, headsign,
                 board: StopSummary, alight: StopSummary,
                 board_time, alight_time, num_stops }
Leg (transfer) { type:"transfer", from: StopSummary, to: StopSummary, walk_seconds }
```

All times absolute ISO 8601 America/Toronto. `from`/`to` are `null` when that
endpoint is ambiguous (its matches are in `candidates`).

## Delivery — 3 staged PRs

- **PR1** — DTOs (`schemas/itinerary.ts`) + the query layer (`gtfs/routing/queries.ts`:
  footpaths, access-stop expansion, boarding, riding, service-day resolution) +
  endpoint resolution (`gtfs/routing/index.ts` entry, resolution only). No
  routing loop yet. Fully unit/fixture tested.
- **PR2** — the depart-after ladder (`ladder.ts`) + reconstruction (`reconstruct.ts`)
  + the `plan_trip` tool wired for depart-after. **HITL: routing-loop review.**
- **PR3** — `arrive_by` emulation + alternates/ranking (`rank.ts`) + the
  `plan_a_trip` prompt (`src/prompts/`, `registerPrompts()`).

## Fixed constraints (ADR 0001 / specs)

- Substrate: Turso/libSQL over HTTP — minimise round-trips.
- `max_transfers` default 3, **hard cap 3**; rounds = `max_transfers + 1`.
- `max_itineraries` default 3. `modes` filters `subway|streetcar|bus`.
- `when` defaults to now (Toronto). Static schedule only, no RT.
- Access-stop fan-out bounded (see below).

## The domain model

See `CONTEXT.md`. Key terms: **access stops**, **egress**, **footpath/transfer**
(station/pathway/street), **pattern** (route+direction+headsign), **itinerary**,
**transit leg**, **transfer leg**, **candidate**, **service day**.

## Algorithm

### Time base — absolute epoch, windowed service days

Labels are **absolute epoch seconds**, not seconds-since-service-midnight,
because a multi-hop plan mixes trips from adjacent service days.

At search start, resolve candidate service dates around `depart_time`:
`D-1` (overnight carryover — a `dep > 86400` trip belonging to yesterday),
`D` (the depart date), and `D+1` (only if the search frontier crosses midnight).
Reuse `get_schedule`'s `activeServiceIds(client, date)` and `service-time.ts`
(`serviceDateAt`, `addDays`, `absoluteTimeFor`, `secondsSinceServiceMidnight`,
`toIsoWithTorontoOffset`). For each candidate date `d`, a stop's absolute label
translates to that date's dep-space: `min_dep_d = label − serviceMidnight(d)`.
Boarding runs per date and merges by **earliest absolute arrival**.

### Labels & rounds

Two-array RAPTOR-lite:

- `best[stop]` — best (earliest) absolute-arrival label reached so far.
- Per round, a **marked set** of stops improved in the previous round.
- **Parent pointers** for reconstruction: for each improvement, store how the
  stop was reached — `{ via: "transit", trip_id, board_stop, board_seq,
  board_time } | { via: "transfer", from_stop, walk_seconds }`.

Rounds = `max_transfers + 1`. Round loop:

1. **Board + ride** from the marked set (two SQL queries, below), relaxing
   downstream arrival labels using `arr` (fallback `dep`).
2. **Footpath relaxation:** for each stop improved in step 1, propagate
   `label + min_walk_seconds` to its `transfers` targets — but **only after a
   transit leg** (a stop reached by a transfer is not itself relaxed again via a
   transfer; no back-to-back footpaths).
3. Next round marks the stops improved in steps 1–2.

**Seeding (round 0):** origin access stops get `best = depart_time + access_walk`;
then an **initial footpath relaxation** among the origin's transfer-neighbours so
a nearby stop is boardable on round 0.

**Termination:** all rounds consumed, or no stop improved in a round.

### Boarding query (per candidate service date)

```sql
WITH marked(stop_id, min_dep) AS (VALUES (?, ?), (?, ?), ...)
SELECT st.stop_id, t.route_id, t.direction_id, t.trip_headsign,
       MIN(st.dep) AS dep, st.trip_id
FROM stop_times st
JOIN marked m ON m.stop_id = st.stop_id AND st.dep >= m.min_dep
JOIN trips  t ON t.trip_id = st.trip_id
WHERE t.service_id IN (<active for this date>)
  [AND EXISTS (SELECT 1 FROM routes r WHERE r.route_id = t.route_id
               AND r.route_type IN (<modes>))]
GROUP BY st.stop_id, t.route_id, t.direction_id, t.trip_headsign
```

- Per-stop thresholds are enforced in SQL via the `VALUES` CTE join — never a
  shared global min (that would let `MIN(dep)` pick a trip departing before a
  given stop's own label and wrongly discard the pattern; see grilling notes).
- `GROUP BY (stop_id, route_id, direction_id, trip_headsign)` + `MIN(dep)` =
  **earliest trip per pattern** (ADR 0002). SQLite's bare-column-with-`MIN`
  returns the matching `trip_id`.
- Mode filter pushed into SQL. Uses index `ix_st_stop_dep (stop_id, dep)`.

### Riding query

```sql
SELECT st.trip_id, st.stop_id, st.stop_sequence, st.arr, st.dep
FROM stop_times st
WHERE st.trip_id IN (<boarded trip_ids>)
ORDER BY st.trip_id, st.stop_sequence
```

For each boarded `(trip_id, board_seq)`, relax every downstream stop
(`stop_sequence > board_seq`) to `absoluteTimeFor(date, arr ?? dep)` if earlier
than its current `best`. Uses index `ix_st_trip_seq (trip_id, stop_sequence)`.

### Footpaths & access stops

`gtfs/routing/queries.ts`:

- `fetchFootpaths(client, stopIds)` — `SELECT from_stop_id, to_stop_id,
  min_walk_seconds, type FROM transfers WHERE from_stop_id IN (...)`
  (index `ix_transfers_from`). **Temporarily excludes `type = 'pathway'`**
  (issue #39: ingested pathway rows carry an un-crosswalked Dataset B stop_id
  namespace — 91% connect stops kilometres apart, causing "teleport" plans;
  found by the `npm run smoke:plan` real-DB smoke). Subway interchanges still
  resolve via `station` transfers. Remove the filter once #39 re-ingests.
- **Access stops** for an endpoint:
  - `stop_id` → the stop itself (walk 0) + its footpath neighbours. **A station
    (parent, no `stop_times`) expands to its child platforms** (walk 0) — trips
    reference platforms, not the station — and footpaths radiate from those
    platforms. (Confirmed necessary against the real DB: "Union Station" resolves
    to the parent.)
  - name → resolve (below); the resolved stop's access set as above.
  - `{lat, lon}` → `searchStopsNear(radius)`; walk = `haversine ÷ 1.3 m/s`.
    Access radius **250 m** (matches the street-transfer radius), fan-out
    **bounded** (cap the nearest N, e.g. 8).
- **Egress:** destination access stops mirror the origin; the egress footpath's
  `min_walk` (or coordinate haversine) is added to the arrival label used for
  ranking.

### Reconstruction (PR2)

Backtrack parent pointers from the best destination access stop. Merge
**consecutive same-`trip_id`** hops into one **transit leg** with
`board`/`alight` (`StopSummary`), `board_time`/`alight_time`, `num_stops`
(alight_seq − board_seq), `mode`/`route_id`/`route_short_name`/`headsign` from
`trips`+`routes`. **Transfer legs** sit between transit legs (and at the ends for
access/egress walks). `transfers` = count of transit legs − 1.

### arrive_by (emulated, PR3)

Forward engine only:

1. Forward-solve from an early anchor to learn the fastest feasible duration Δ to
   the destination (and that it's reachable at all).
2. Probe departure `≈ T − Δ − slack`.
3. Forward depart-after from the probe.
4. Keep itineraries with `arrive_time ≤ T`; **rank by latest `depart_time`**,
   then shortest duration.

### Alternates & ranking (PR3)

- Earliest-arrival itinerary `I1` first.
- Re-run depart-after from just after `I1`'s first boarding time → next
  itinerary; repeat until `max_itineraries` filled or no improving/feasible
  result. **Bound shift attempts at ~2 × max_itineraries.**
- **Distinctness key = ordered `route_id`s of the transit legs** (same routes /
  later train is not a new option).
- Final sort by arrival time (for `arrive_by`, by latest departure).

## Endpoint resolution & candidates (ADR 0002)

`gtfs/routing/index.ts`:

- `stop_id` → `getStopById`; missing → `error: not_found`.
- name → `searchStopsByName`; **> 1 match ⇒ ambiguous** → success-shaped
  `candidates: { endpoint, matches }`, `itineraries: []`, the ambiguous side's
  top-level `from`/`to` is `null`. Resolve `from` first, then `to`.
- `{lat, lon}` → `searchStopsNear`; never ambiguous; empty → `not_found`.
- Endpoints resolve but nothing reachable → `error: no_results` (empty + note).

## Cost budget

Per plan: (rounds ≤ 4) × (≤ #candidate-dates, usually 1) × 2 queries, ×
(≤ max_itineraries + arrive_by probe) re-runs. Bounded by the pattern-key
pruning, per-stop `VALUES` thresholds, bounded access fan-out, and hard
`max_transfers ≤ 3` — the guards ADR 0001 requires.

## Testing

Fixture-DB integration tests via `buildFixtureDb` (`gtfs/test-support.ts`),
extended with: a transfer pair, a two-seat ride, a branch (two headsigns), and a
past-midnight trip. Pure `reconstruct`/`rank` unit-tested without a DB. Each task
green on `npm run typecheck && npm run lint && npm run format:check && npm test`.

## Scope guard (NOT in v1 — from spec)

Multi-agency GO+TTC; deep walking-network/first-mile; per-leg fare computation;
RT-aware routing.
