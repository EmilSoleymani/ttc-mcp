---
id: "008"
title: "Grilling: GTFS-RT Real-time Integration & Cache Deltas"
type: grilling
status: resolved
blocked_by: ["001", "005"]
blocks: ["009"]
---

## Question

Design how the three GTFS-RT feeds (VehiclePositions, TripUpdates, Alerts) are consumed and mapped to the real-time tools, and record the caching **deltas** from go-planner's cloned caching spec. Work one question at a time.

**Confirmed inputs from ticket 001:** GTFS-RT is **protobuf-only** (v2.0, `?format=json` ignored, no auth/documented rate limits); **TripUpdates carry real epoch-time predictions**; **vehicles + trip-updates are BUS + STREETCAR ONLY — there is NO subway real-time** (subway appears only in Alerts + static schedule).

Decisions needed:
1. **Wire format & decoding** — **CONFIRMED protobuf, no JSON option.** Decide the decode approach (`gtfs-realtime-bindings` vs. `protobufjs` + the GTFS-RT proto) and confirm it into the ticket-004 dependency delta. (No JSON shortcut available.)
2. **Feed → tool mapping** — how VehiclePositions backs "live vehicles", how TripUpdates backs "next arrivals at a stop" (joining RT `trip_id`/`stop_id` back to the ingested static GTFS from ticket 006), how Alerts backs the alerts tool. **Predictions ARE real (001), so no adherence-delta fallback needed for surface routes. BUT decide the honest behaviour for subway stops, which have NO real-time at all — arrivals must fall back to the ingested GTFS timetable and be labelled "scheduled", and live-vehicle tools must clearly report subway as unsupported rather than empty.**
3. **Static ↔ RT join** — RT entities reference GTFS ids; the join to human-readable stop/route names goes through the ingested catalog. Nail this dependency on ticket 006's query layer.
4. **Caching TTLs (delta)** — go-planner: real-time never cached. Decide TTC RT TTLs (likely a short 10–30s coalescing TTL to avoid hammering on bursty tool calls) vs. never-cache; static/catalog reads follow the GTFS-refresh model, not the cloned 6h schedule TTL.
5. **Retry** — confirm ADR-0001 conservative retry applies unchanged to the RT endpoints.

**Deliverable:** `docs/spec/realtime-integration.md` in the repo; feed the protobuf decision back to ticket 004's dependency delta.

## Answer

Grilled 2026-07-23. Full spec: [`../../docs/spec/realtime-integration.md`](../../docs/spec/realtime-integration.md).

- **Decoder: `gtfs-realtime-bindings`** (official MobilityData bindings) → concretizes the stack-baseline "protobuf dependency" delta.
- **Caching (delta from go-planner never-cache): short coalescing TTL** — decode each feed ≤ once per `RT_CACHE_TTL_SECONDS` (default 25s), build in-memory indexes (`stop→arrivals`, `route→vehicles`), serve tool calls from them. Honors `CACHE_ENABLED`; in-process per-instance (full on Docker, best-effort on Vercel warm). **ADR-0001 retry applies unchanged.**
- **Feed→tool:** VehiclePositions→`get_vehicles` (drop empty-route_id deadheads; subway route → `unsupported` empty+note); TripUpdates→`get_arrivals` (predicted epoch→ISO, join trip_id→catalog); Alerts→`get_alerts` (filter by informed_entity + derived category, subway-inclusive).
- **Unified `get_arrivals` fallback finalized:** detect stop `mode`; subway (or any stop with no live trips in window) → serve scheduled from the ticket-007 `get_schedule` path, `realtime:false`/`source:"scheduled"`. Always answers.
- **Arrival DTO finalized:** `{route_id, route_short_name, headsign, direction_id, time, realtime, source, delay_seconds?}`; `delay_seconds` computed only when scheduled time resolvable.
- **Static↔RT join risk flagged:** RT `trip_id` assumed-but-not-guaranteed to match static; spec'd a first-impl validation + a fallback that never drops an arrival on an unmatched trip_id.
