---
label: wayfinder:map
---

# TTC MCP Server — Wayfinder Map

## Destination

A complete technical spec and TTC data-source research report for a **TTC (Toronto Transit Commission) MCP server**, ready to hand off to a separate implementation agent. The spec covers the tool/primitive roster, GTFS static-feed ingestion & storage, GTFS-RT real-time integration, tool schemas, and the stack baseline inherited from `go-planning-mcp`. No code is written by this map — only decisions. `plan_trip` (multi-modal transfer routing) is the deliberately-deferred capstone decision, resolved last.

## Notes

- **Domain:** Toronto Transit Commission (subway, streetcar, bus) trip-planning MCP server, sibling to `go-planning-mcp` (GO Transit / Metrolinx).
- **Stack: cloned wholesale from `go-planning-mcp`.** TypeScript / Node.js + `@modelcontextprotocol/sdk`, transport-agnostic `buildServer()` (stdio + Streamable HTTP), Vercel Hobby + Docker hosting, MIT. The architecture / CI-CD / test / Docker / caching-&-retry specs are **inherited by reference** from go-planner's `docs/spec/*` — not re-grilled. Only genuine TTC-specific **deltas** get tickets. Baseline reference: `../../go-planning-mcp/.wayfinder/map.md` and `../../go-planning-mcp/docs/spec/`.
- **Data sources: official only.** Static GTFS ZIP from `open.toronto.ca` ("TTC Routes and Schedules", refreshed ~every 6 weeks) + GTFS-Realtime at `bustime.ttc.ca/gtfsrt/` (vehicle positions, trip updates, service alerts). **No API key, no signup, no auth.** The reverse-engineered Bustime v3 prediction API and the `myttc.ca` wrapper are **out of scope** (unsanctioned / unreliable).
- **Key TTC-specific concern go-planner did NOT have:** there is *no live schedule-query API*. TTC's schedule data is a GTFS ZIP you must **ingest, store, and query yourself**. This ingestion/storage design (given Vercel's ephemeral filesystem + Docker) is the crux of the map and the foundation `plan_trip` sits on.
- **`plan_trip` is deferred — what AND how.** It is a single late ticket blocked by everything else. Its routing approach (real routing engine like OTP/Motis vs. hand-composed schedule-walking, à la go-planner's ADR-0003 transfer-composition ladder) is decided *in that ticket*. Architecture must stay routing-agnostic without painting itself into a corner.
- **Tool naming:** TTC-native, whatever makes sense for TTC — NOT a mechanical copy of go-planner's tool names.
- **Skills to consult:** `/grilling`, `/domain-modeling`, `/research`.
- Every grilling ticket is worked **one question at a time**, waiting for user input.

## Decisions so far

- [Grilling: GTFS-RT Real-time Integration & Cache Deltas](tickets/008-realtime-integration.md) — decoder **`gtfs-realtime-bindings`**; **short coalescing cache** (decode each feed ≤ once per 25s, in-memory `stop→arrivals`/`route→vehicles` indexes) — the delta from go-planner never-cache; ADR-0001 retry unchanged. Feed→tool mapping wired (deadhead filtering, subway `unsupported` for vehicles); **unified `get_arrivals` fallback finalized** (subway/no-live → scheduled, `realtime:false`); Arrival DTO finalized; **RT `trip_id`↔static-join risk** flagged with a validation + never-drop fallback. Spec [docs/spec/realtime-integration.md](../docs/spec/realtime-integration.md).
- [Grilling: Tool Schema & DTO Design](tickets/007-tool-schema-design.md) — **`stop_id` canonical** (stations aggregate child platforms grouped by direction), **`route_id` canonical** (one identity model), times **absolute ISO 8601 + Toronto offset**, `get_schedule` a **single bounded next-N tool** (cap ~20, truncated+hint). Snake_case Zod `outputSchema`/`structuredContent` on all tools; closed-enum in-result errors (`ambiguous` → candidate list as success). Full per-tool DTOs for all 10 tools + 3 Resources in [docs/spec/tool-schemas.md](../docs/spec/tool-schemas.md). RT field shapes → 008; plan_trip DTO → 009.
- [Grilling: GTFS Ingestion & Storage Design](tickets/006-ingestion-storage-design.md) — **the crux, resolved with a real measurement** (built the 4.2M-row DB): optimized = **237 MB**, over Vercel's ~250 MB budget → **substrate is Turso/libSQL** (Vercel queries remote; Docker uses a local libSQL file; one `@libsql/client` path, hand-rolled query layer, no node-gtfs). Schema: typed, int seconds-since-midnight times. Feeds: **A** for schedules + **B's `pathways`/`levels`** for subway interchanges (no `transfers.txt`). Refresh: weekly cron + CKAN poll → push to Turso on change. **Ripple: Turso reintroduces secrets** (`LIBSQL_AUTH_TOKEN`/Vercel, Turso creds/CI) — amends 002 + stack-baseline. Full spec [docs/spec/gtfs-ingestion.md](../docs/spec/gtfs-ingestion.md).
- [Grilling: MCP Tool & Primitive Roster](tickets/005-tool-roster.md) — **10 TTC-native tools** (search_stops, get_stop, list_routes, get_route, get_schedule, get_arrivals, get_vehicles, get_alerts, get_fare, + reserved plan_trip). Subway asymmetry handled by a **unified `get_arrivals`** that falls back to scheduled times (tagged `realtime:false`) for subway; `get_vehicles` returns empty+reason for subway. Catalog + fares exposed as **both Resources (`ttc://stops|routes|fares`) and mirror Tools**. v1 prompts: `check_my_commute`, `service_status`, `nearby_stops` (+ `plan_a_trip` reserved → 009). RT only via filtered tools. Detail → 007/008/009.
- [Grilling: Stack Baseline & Deltas from go-planner](tickets/004-stack-baseline.md) — **clone go-planner wholesale**: all five specs (architecture, test, CI/CD, Docker, caching) + Node `[20,22]` inherited **verbatim** (full record in [docs/spec/stack-baseline.md](../docs/spec/stack-baseline.md)). Confirmed deltas: **protobuf dep forced** (JSON approach dropped), GTFS-ingestion deps, **no API-key secret**, **+GTFS-refresh workflow** (shape TBD in 006), +GTFS/protobuf test fixtures, 6h schedule-TTL moot (schedules are a local DB now). Identity **`ttc-mcp`** on npm + ghcr → **closes ticket 002's package-name item**. Hosting: Vercel + Docker both first-class; `.db`-vs-Vercel-budget measurement (ticket 006) decides bake-in vs. Turso.
- [Research: TTC Feed & API Inventory](tickets/001-ttc-feed-inventory.md) — **GTFS-RT is protobuf-only** (`?format=json` ignored → protobuf dep forced); **TripUpdates carry real epoch-time predictions** (no unofficial API needed); **`transfers.txt`, fare_attributes/fare_rules, frequencies are ABSENT** (calendar/calendar_dates/shapes present → forces proximity/interchange transfer model + no GTFS fare data); **two merged all-modes datasets** (35 MB `opendata_ttc_schedules.zip` ~6-wk vs. 81 MB `completegtfs.zip` quarterly); **NO subway real-time** — vehicles/trip-updates are bus+streetcar only, subway is Alerts + schedule only. Open risk: OGL-Toronto vs. CKAN `notspecified` license discrepancy; RT terms/rate-limits undocumented.
- [Research: GTFS Static Ingestion & Query Approaches](tickets/003-gtfs-ingestion-research.md) — lean **`node-gtfs`/better-sqlite3 → read-only SQLite baked into the deploy artifact, cron rebuild-and-redeploy** for the ~6-week refresh; one query codepath across Docker (writable FS) and Vercel (read-only bundle). Fallback **Turso/libSQL** if the derived `.db` won't fit. RAPTOR/CSA trip-planning wants a separate in-memory timetable substrate (→ ticket 009, likely Docker-first). Hard constraint: better-sqlite3 works on Vercel Hobby only if compiled at build & queried read-only; **open unknown = derived `.db` size vs. Vercel bundle/cold-start budget — ticket 006 must measure it.**

## Not yet specified

<!-- fog: in scope, not yet sharp enough to ticket; graduates as the frontier advances -->

<!-- CI/CD & Docker ingestion deltas: GRADUATED — resolved by ticket 006 into the gtfs-ingestion.md spec (weekly cron + CKAN poll → push to Turso; Docker bakes a local libSQL file). No separate ticket needed. -->
<!-- Resources & Prompts roster: GRADUATED — resolved by ticket 005 (Resources ttc://stops|routes|fares + mirror Tools; prompts check_my_commute/service_status/nearby_stops, plan_a_trip reserved). -->

_(none — the way to the destination is fully charted; only tickets 007, 008, and the 009 capstone remain, all specifiable.)_

## Out of scope

- **Unofficial data sources** — the reverse-engineered Bustime v3 prediction API (HMAC-signed, app credentials extracted from TTC's web client) and the ~20-year-old `myttc.ca` wrapper. Ruled out for a shippable v1: unsanctioned for third-party use / unreliable. Revisit only if the official GTFS-RT feed proves to lack needed arrival predictions.
- **The frontend app** (mobile + web) that will consume this MCP — separate future effort.
- **The backend** that will eventually orchestrate GO + TTC MCPs — deferred.
- **Per-user authentication** on the MCP server — self-hosters need no credentials; the official TTC feeds are keyless.

---

## Ticket Index

### Frontier (unblocked, open)

- [Task: Create ttc-mcp Repo & Deployment](tickets/002-create-repo.md) — HITL; repo + initial commit done, **Vercel wiring + Turso env/secrets remain** (per 006)
- [Grilling: plan_trip — Multi-modal Transfer Routing](tickets/009-plan-trip-routing.md) — **now fully unblocked** (005 + 006 + 007 + 008 all resolved) — the deferred capstone; resolving it reaches the destination

### Blocked (open, waiting)

_(none — the only remaining decision ticket, 009, is on the frontier)_

### Resolved

- [Grilling: GTFS-RT Real-time Integration & Cache Deltas](tickets/008-realtime-integration.md) — gtfs-realtime-bindings decoder, short coalescing cache, feed→tool mapping + subway fallback, trip_id-join risk flagged ([docs/spec/realtime-integration.md](../docs/spec/realtime-integration.md))
- [Grilling: Tool Schema & DTO Design](tickets/007-tool-schema-design.md) — stop_id/route_id canonical, stations aggregate, ISO 8601 Toronto times, bounded next-N get_schedule, closed-enum errors ([docs/spec/tool-schemas.md](../docs/spec/tool-schemas.md))
- [Grilling: GTFS Ingestion & Storage Design](tickets/006-ingestion-storage-design.md) — measured DB = 237 MB → **Turso/libSQL** substrate; A schedules + B pathways/levels; weekly cron+poll refresh ([docs/spec/gtfs-ingestion.md](../docs/spec/gtfs-ingestion.md))
- [Grilling: MCP Tool & Primitive Roster](tickets/005-tool-roster.md) — 10 TTC-native tools + Resources + 3 v1 prompts; unified get_arrivals w/ scheduled subway fallback; plan_trip/plan_a_trip reserved → 009
- [Grilling: Stack Baseline & Deltas from go-planner](tickets/004-stack-baseline.md) — clone go-planner verbatim + confirmed deltas; identity `ttc-mcp`; hosting decision deferred to 006 ([docs/spec/stack-baseline.md](../docs/spec/stack-baseline.md))
- [Research: TTC Feed & API Inventory](tickets/001-ttc-feed-inventory.md) — protobuf-only RT, real predictions, NO transfers.txt/fares/subway-RT, two datasets (35/81 MB); license discrepancy flagged
- [Research: GTFS Static Ingestion & Query Approaches](tickets/003-gtfs-ingestion-research.md) — lean node-gtfs/SQLite baked into deploy, Turso fallback; open unknown = derived `.db` size vs. Vercel budget (ticket 006 to measure)
