# GTFS-RT Real-time Integration & Cache Deltas

**Status:** accepted (wayfinder ticket 008, 2026-07-23)
How the three GTFS-RT feeds are consumed and mapped to the real-time tools, and the caching deltas from go-planner's cloned [caching spec](./stack-baseline.md). Grounded in the [ticket-001 feed inventory](../../.wayfinder/research/001-ttc-feed-inventory.md).

## Confirmed constraints (ticket 001)

- Protobuf-only, GTFS-RT v2.0, `FULL_DATASET`. No JSON. No auth, no documented rate limits.
- TripUpdates carry **real epoch-time predictions** (`arrival.time`/`departure.time`), no `delay` field.
- **Bus + streetcar only** — no subway VehiclePositions/TripUpdates. Alerts cover subway.
- Endpoints: `https://bustime.ttc.ca/gtfsrt/{vehicles,trips,alerts}`.

## Decisions

### 1. Decode library — `gtfs-realtime-bindings`

The official MobilityData npm bindings for GTFS-RT v2.0. **Feeds back to the [stack-baseline](./stack-baseline.md) architecture delta as the chosen decoder** (the confirmed "protobuf dependency" is `gtfs-realtime-bindings` + its `google-protobuf` runtime).

### 2. Caching — short coalescing TTL (delta from go-planner's never-cache)

Each feed is fetched + decoded **at most once per `RT_CACHE_TTL_SECONDS` (default 25s**, matching publish cadence); within the window all tool calls are served from an in-memory decoded+indexed snapshot. Honors go-planner's `CACHE_ENABLED` (set false → per-call fetch). **Location:** in-process, per-instance — full on Docker, best-effort on Vercel warm instances (same caveat as go-planner's cache spec). Retry: **ADR-0001 conservative retry applies unchanged** to the three RT GETs.

Per fetch, build indexes once: `stop_id → arrivals` (from TripUpdates), `route_id → vehicles` (from VehiclePositions), and the alerts list. Tool calls hit the index, never re-scan the raw feed.

### 3. Feed → tool mapping

**VehiclePositions → `get_vehicles(route_id)`**
Group decoded vehicles by `route_id`; return those for the requested route. Drop vehicles with **empty `route_id`** (deadheading/unassigned — ~549 in a sample) or mark them `in_service:false`. `Vehicle { vehicle_id, lat, lon, bearing?, route_id, trip_id?, headsign?, occupancy_status?, timestamp }` (timestamp → ISO 8601 Toronto).
- **Subway route → `{ vehicles: [], realtime_available: false, note: "TTC does not publish subway vehicle positions" }`** (error code `unsupported`).

**TripUpdates → `get_arrivals(stop_id, route_id?)`**
From the `stop_id → arrivals` index, collect upcoming stop_time_updates for the stop; predicted time = `arrival.time` (fallback `departure.time`) epoch → ISO. Join `trip_id` → static trip for `route_id`/`headsign`/`direction_id` (see join below). Finalized `Arrival` shape (compatible with ticket 007):
```
Arrival { route_id, route_short_name, headsign, direction_id,
          time, realtime: boolean, source: "predicted" | "scheduled",
          delay_seconds? }
```
`delay_seconds` = predicted − scheduled when the scheduled time for that trip/stop is resolvable from the ingested GTFS; omitted otherwise (TTC gives no `delay`). For a **station** id, results are aggregated across child platforms and grouped by direction (ticket 007).

**Subway / no-live-data fallback (the unified-tool behaviour):** `get_arrivals` looks up the stop's `mode` from the catalog. For a **subway** stop — or any stop with no matching RT trips in the window — it serves the next scheduled departures from the ticket-007 `get_schedule` query path, with `realtime:false`, `source:"scheduled"`. `realtime_available` on the envelope reflects whether *any* RT prediction was found. The tool therefore always answers.

**Alerts → `get_alerts(mode?, route_id?, stop_id?, category?)`**
Filter decoded alerts by `informed_entity` (`route_id`/`stop_id`/mode) and derived `category`. Subway-inclusive. Map `cause`/`effect`/`severity_level`; derive `category` (`elevator | escalator | detour | delay | no_service | planned`) from effect + header text. `Alert` shape per ticket 007. Small feed — cached under the same TTL.

### 4. Static ↔ RT join (dependency on ticket 006 query layer)

RT entities carry `trip_id`/`stop_id`/`route_id`; human-readable names + `direction_id`/`headsign`/scheduled times come from the **ingested Turso catalog** (ticket 006). `stop_id`/`route_id` match the static feed by construction.

**⚠ Risk — `trip_id` match:** GTFS-RT `trip_id` is *assumed* to match the static feed's `trip_id`, but this is not guaranteed across TTC's Clever Devices backend and the City's static export. **Required first-implementation validation:** sample the live TripUpdates feed and confirm `trip_id` overlap with static `trips`. **Fallback if unmatched:** surface `route_id` + RT-provided headsign directly from the RT entity (predictions still usable), and set `source:"predicted"` without the static enrichment. Never drop an arrival solely because its `trip_id` didn't join.

## Config surface (adds to ticket 006's table)

| Var | Purpose | Default |
|---|---|---|
| `RT_CACHE_TTL_SECONDS` | coalescing window for decoded RT feeds | `25` |
| `CACHE_ENABLED` | inherited (false → per-call fetch, no coalescing) | `true` |
| `GTFS_RT_BASE_URL` | overridable RT base (`https://bustime.ttc.ca/gtfsrt`) | prod URL |

## Hand-offs
- **Ticket 004 / stack-baseline:** decoder is `gtfs-realtime-bindings` (updates the "protobuf dependency" delta).
- **Ticket 009:** `plan_trip` may consume the same cached TripUpdates index for realtime-aware legs (surface only; subway static) — optional, static-first per that ticket.
