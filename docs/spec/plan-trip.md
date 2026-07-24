# plan_trip — Multi-modal Transfer Routing

**Status:** accepted (wayfinder ticket 009, 2026-07-23) — **the capstone; resolving it completes the map.**
Routing approach decided in [ADR 0001](../adr/0001-plan-trip-sql-schedule-walking.md): SQL schedule-walking over the Turso query layer.

## Transfer model (precomputed)

Because `transfers.txt` is absent (ticket 001), a synthetic **`transfers` table is generated at ingest** (ripples to [gtfs-ingestion.md](./gtfs-ingestion.md)):

`transfers(from_stop_id, to_stop_id, min_walk_seconds, type)` where `type ∈ {station, pathway, street}`:
- **station** — stops sharing a `parent_station` (in-station, minimal walk).
- **pathway** — subway in-station walks derived from Dataset B's `pathways`/`levels` (accurate platform-to-platform times).
- **street** — stops within R meters (R ≈ 250 m) via haversine, walk time = distance ÷ ~1.3 m/s.

Indexed on `from_stop_id`. This is the missing `transfers.txt`, manufactured once.

## Algorithm — bounded RAPTOR-lite over SQL

1. **Resolve endpoints.** `from`/`to` accept a `stop_id`, a place name, or `lat,lon`. Names resolve via the catalog; **ambiguous → return `candidates` as a success** (ticket 007 taxonomy), do not route. Each endpoint expands to a small set of **access stops** (itself + nearby stops from `transfers`).
2. **Rounds = max_transfers + 1** (default 4). Maintain earliest-arrival label per reached stop.
   - **Round 0:** from origin access stops, at/after `depart_time`, find trips departing each stop and their downstream stops with arrival times (one batched `stop_times` query per round using `IN (stops)` + `dep >= label`). Update labels.
   - **Between rounds:** relax via the `transfers` table — propagate each stop's arrival + `min_walk_seconds` to its transfer targets.
   - **Round k:** board next trips from stops improved in round k−1; expand. Stop when destination access stops are reached or rounds exhausted.
3. **Reconstruct** itineraries by backtracking the labels into legs.
4. **Rank** by arrival time; return up to `max_itineraries` (default 3) distinct options (earliest-arrival + alternates from shifted departures). Honors `calendar`/`calendar_dates` for the service day.

`arrive_by` is **emulated** (backward search / latest-departure heuristic), consistent with go-planner. Static schedule only for v1 (no RT).

**Cost control:** precomputed transfers (no request-time geo-scans), batched per-round `IN` queries, caps on max_transfers (≤3) and access-stop fan-out bound the Turso round-trips.

## Tool contract

**Input:** `plan_trip({ from, to, when?, arrive_by?, max_transfers?, modes?, max_itineraries? })`
- `from`/`to`: `stop_id` | place name | `{lat, lon}`.
- `when`: ISO 8601, default now (Toronto). `arrive_by`: boolean, default false (depart-after).
- `max_transfers`: default 3. `modes?`: filter `subway|streetcar|bus`. `max_itineraries`: default 3.

**Output:** `{ from: StopSummary, to: StopSummary, itineraries: Itinerary[], candidates? }`
```
Itinerary { depart_time, arrive_time, duration_seconds, transfers, legs: Leg[] }
Leg (transit)  { type:"transit", mode, route_id, route_short_name, headsign,
                 board: StopSummary, alight: StopSummary, board_time, alight_time, num_stops }
Leg (transfer) { type:"transfer", from: StopSummary, to: StopSummary, walk_seconds }
```
All times absolute ISO 8601 (America/Toronto), reusing ticket-007 DTOs. On an ambiguous endpoint, `candidates` is populated and `itineraries` is empty (success-shaped).

## Prompt

Ships the **`plan_a_trip`** prompt reserved in ticket 005 (wraps `plan_trip`).

## Scope guard (explicitly NOT in v1)

- **Multi-agency GO + TTC routing** — deferred to the future backend effort (out of scope for this MCP).
- **Deep walking-network / first-mile routing** from arbitrary coordinates — v1 snaps to nearby stops only.
- **Fare computation per itinerary** — fares are a flat table (`get_fare`); itineraries may note the flat fare but don't compute per-leg costs.
- **RT-aware routing** — documented future enhancement (surface TripUpdates only; subway has no RT anyway).
