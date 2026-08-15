# Tool Schema & DTO Design

**Status:** accepted (wayfinder ticket 007, 2026-07-23)
Detailed input/output schemas for the [ticket-005 roster](../../.wayfinder/tickets/005-tool-roster.md). Adopts go-planner's schema conventions; identity/time/shape decisions are TTC-specific.

## Conventions (adopted from go-planner)

- **Normalized snake_case DTOs** — never raw GTFS/GTFS-RT passthrough. Every tool has a Zod `outputSchema` and returns `structuredContent`.
- **Times: absolute ISO 8601 with America/Toronto offset** (e.g. `2026-07-24T14:35:00-04:00`). The stored int seconds-since-midnight are resolved against the service date, so past-midnight GTFS times (`25:10:00`) correctly become next-day timestamps. Inputs accept ISO 8601; omit = now (Toronto).
- **In-result errors, closed code enum.** Errors are returned in the result payload (not transport errors). A name that matches several stops is a **success** returning a candidate list, not an error.
- **Anti-dump everywhere:** list-returning tools are capped, set `truncated: true` when clipped, and include a `hint` to narrow.

## Identity model

- **Stops:** canonical handle is the opaque **`stop_id`** (numeric string; universal — every platform has one). Stations aggregate: passing a **station** id to `get_schedule`/`get_arrivals` returns results across its child platforms **grouped by direction/headsign**. DTOs also carry `stop_code` (rider-facing 5-digit, surface stops only), `name`, `mode`, `is_station`, `parent_station`, `lat`/`lon`, `accessible`.
- **Routes:** canonical handle is **`route_id`** (for TTC reads as the route number — `504`, `1`). DTOs carry `route_short_name`, `route_long_name`, `mode`, and subway line `color`/`name`. Human names ("King", "Line 1") resolve via `search`/catalog fuzzy match.
- **Modes:** enum `subway | streetcar | bus` (from GTFS `route_type` 1/0/3).

## Shared DTOs

```
StopSummary  { stop_id, stop_code?, name, mode, is_station, parent_station?, lat, lon, accessible?, routes?: string[] }
RouteSummary { route_id, route_short_name, route_long_name, mode, color? }
```

## Tools

**1. `search_stops`** — `{ query?, near?: {lat, lon, radius_m?}, mode?, limit? }` → `{ stops: StopSummary[], truncated }`. Name and/or proximity search; either `query` or `near` required. Cap ~20.

**2. `get_stop`** — `{ stop_id }` → `StopSummary & { platforms?: StopSummary[], routes: RouteSummary[] }`. For a station, `platforms` lists child stops.

**3. `list_routes`** — `{ mode? }` → `{ routes: RouteSummary[] }`. Full route catalog (233 routes — bounded set, no cap needed) filtered by mode.

**4. `get_route`** — `{ route_id }` → `RouteSummary & { directions: {direction_id, headsign}[], stops_by_direction?: {direction_id, stops: StopSummary[]}[] }`. Stops listed per direction; capped with `truncated` (a route can have many stops).

**5. `get_schedule`** — `{ stop_id, route_id?, when?, limit? }` → `{ stop: StopSummary, departures: ScheduledDeparture[], truncated, hint? }`. Next-N (**cap ~20**) scheduled departures from `when` (default now), honoring `calendar` + `calendar_dates` exceptions for the service day. `ScheduledDeparture { route_id, route_short_name, headsign, direction_id, scheduled_time, platform_stop_id? }`.

**6. `get_arrivals`** — `{ stop_id, route_id?, limit? }` → `{ stop, arrivals: Arrival[], realtime_available: boolean, truncated }`. **Unified** (ticket 005): live predictions for bus/streetcar; for subway transparently returns scheduled times. `Arrival { route_id, route_short_name, headsign, direction_id?, time, realtime: boolean, source: "predicted" | "scheduled", delay_seconds?, unavailable? }`. `direction_id` and `delay_seconds` are optional because #33's posture is to decline rather than guess: each is omitted when it cannot be established, with `unavailable: [{ field, reason }]` naming why on live arrivals (`unmatched_trip | frequent_service | no_scheduled_service`, see [ADR 0003](../adr/0003-schedule-adherence-identifiability.md)). For a station, grouped by direction. Field shape is **finalized in ticket 008**; kept compatible here.

**7. `get_vehicles`** — `{ route_id, limit? }` → `{ route_id, vehicles: Vehicle[], realtime_available: boolean }`. Server-side filtered by route. `Vehicle { vehicle_id, lat, lon, bearing?, trip_id?, headsign?, timestamp }`. **Subway routes → `vehicles: [], realtime_available: false`** with a `note` (no subway RT).

**8. `get_alerts`** — `{ mode?, route_id?, stop_id?, category?, limit? }` → `{ alerts: Alert[], truncated }`. Subway-inclusive. `Alert { id, header, description?, severity?, cause?, effect?, category, informed: {routes?, stops?, modes?}, active_period?, url? }`. `category` includes `elevator | escalator | detour | delay | no_service | planned | other` (`other` = a notice with no confident effect/text signal, e.g. a fare/safety notice — not asserted to be a concrete `detour`).

**9. `get_fare`** — `{ category?, fare_type? }` → `{ fares: Fare[], transfer: {window_minutes: 120, rules: string}, notes?, source_url }`. Hand-maintained static table. `Fare { category: "adult"|"senior"|"youth"|"child", fare_type: "presto"|"cash"|"day_pass"|"monthly", price, currency: "CAD" }`.

**10. `plan_trip`** — **reserved**; input/output schema designed in ticket 009.

## Resources

`ttc://stops`, `ttc://routes`, `ttc://fares` — serialized with the same DTOs (`StopSummary[]`, `RouteSummary[]`, `Fare[]`), mirroring tools for Resource-ignoring clients.

## Error taxonomy (closed enum)

Returned in-result as `{ error: { code, message, candidates? } }`:

- `not_found` — unknown `stop_id`/`route_id`.
- `ambiguous` — a name resolved to multiple candidates → **success-shaped**: returns `candidates: StopSummary[] | RouteSummary[]` for the LLM to disambiguate with the user. **Note (ADR 0002):** `plan_trip` returns candidates **top-level** (`candidates: { endpoint, matches }`) with no `error` object, because it has two endpoints and must say which is ambiguous — not nested inside `error` as this line's single-endpoint sketch implies.
- `no_results` — valid query, nothing in window (e.g. no departures before end of service). Success-shaped (empty list + reason), not a hard error.
- `unsupported` — capability absent for the target, e.g. `get_vehicles` on a subway route.
- `invalid_argument` — malformed input (bad time, neither `query` nor `near`).
- `upstream_unavailable` — GTFS-RT feed fetch failed after ADR-0001 retries.

## Hand-offs
- **Ticket 008:** finalizes the `Arrival` real-time fields (`realtime`/`source`/`delay_seconds`) and `Vehicle` shape against the decoded protobuf.
- **Ticket 009:** `plan_trip` DTO — legs with mode/route/board/alight/times/transfers, reusing `StopSummary`/`RouteSummary` and the ISO-8601 time convention.
