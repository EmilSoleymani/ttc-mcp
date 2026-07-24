# ADR 0001 — plan_trip uses SQL schedule-walking, not a routing engine

**Status:** accepted (wayfinder ticket 009, 2026-07-23)

## Context

`plan_trip` must plan journeys across bus, streetcar, and subway with transfers. The surrounding architecture, already decided, constrains the approach heavily:

- **Substrate is Turso/libSQL** (ticket 006): the 4.2M-row `stop_times` timetable lives remotely; queries go over HTTP.
- **Vercel Hobby + Docker are both first-class** (ticket 004): Vercel serverless has cold starts, memory limits, and a ~250 MB function budget; loading a full in-memory timetable there is infeasible.
- **Single TS/Node `buildServer()`** — no separate services, one codepath.
- **No `transfers.txt`** (ticket 001) — interchanges are synthesized (ticket 009 → precomputed transfers table).
- **Precedent:** go-planner solved multi-hub transfers with a hand-composed transfer-composition ladder (its ADR-0003), not an engine.

Options weighed: (a) external routing engine (OpenTripPlanner/Motis), (b) in-process JS RAPTOR/CSA over an in-memory timetable, (c) SQL schedule-walking over the Turso query layer.

## Decision

**SQL schedule-walking** — a bounded, RAPTOR-lite transfer-composition ladder over the Turso query layer, adapting go-planner's ADR-0003 to a single-agency multi-modal network. Earliest-arrival labels per stop, trip expansion via indexed `stop_times` queries, interchanges via the **precomputed synthetic transfers table**, transfers capped (≤3), **static schedule only for v1**.

Rejected: an external engine (breaks the single TS/Node + serverless architecture, heavy self-host infra, duplicates ingestion) and in-process RAPTOR (needs a hundreds-of-MB in-memory timetable → Docker-only, revising "both targets first-class" for this tool).

## Consequences

- **Keeps both hosting targets first-class** and reuses the ticket-006 substrate directly — no new infra.
- **Architecturally consistent** with the rest of ttc-mcp and with the author's go-planner precedent.
- **Trade-off:** lower optimality than a true RAPTOR and more Turso round-trips per plan. Mitigated by the precomputed transfers table (no request-time geo-scans), batched `IN`-queries per round, and hard caps (max_transfers ≤ 3, bounded stop fan-out).
- **Future options remain open:** RT-aware routing (fold in surface TripUpdates) and an in-process RAPTOR for a Docker-only "fast path" are documented enhancements, not v1.
