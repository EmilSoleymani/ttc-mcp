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

- [Grilling: Stack Baseline & Deltas from go-planner](tickets/004-stack-baseline.md) — **clone go-planner wholesale**: all five specs (architecture, test, CI/CD, Docker, caching) + Node `[20,22]` inherited **verbatim** (full record in [docs/spec/stack-baseline.md](../docs/spec/stack-baseline.md)). Confirmed deltas: **protobuf dep forced** (JSON approach dropped), GTFS-ingestion deps, **no API-key secret**, **+GTFS-refresh workflow** (shape TBD in 006), +GTFS/protobuf test fixtures, 6h schedule-TTL moot (schedules are a local DB now). Identity **`ttc-mcp`** on npm + ghcr → **closes ticket 002's package-name item**. Hosting: Vercel + Docker both first-class; `.db`-vs-Vercel-budget measurement (ticket 006) decides bake-in vs. Turso.
- [Research: TTC Feed & API Inventory](tickets/001-ttc-feed-inventory.md) — **GTFS-RT is protobuf-only** (`?format=json` ignored → protobuf dep forced); **TripUpdates carry real epoch-time predictions** (no unofficial API needed); **`transfers.txt`, fare_attributes/fare_rules, frequencies are ABSENT** (calendar/calendar_dates/shapes present → forces proximity/interchange transfer model + no GTFS fare data); **two merged all-modes datasets** (35 MB `opendata_ttc_schedules.zip` ~6-wk vs. 81 MB `completegtfs.zip` quarterly); **NO subway real-time** — vehicles/trip-updates are bus+streetcar only, subway is Alerts + schedule only. Open risk: OGL-Toronto vs. CKAN `notspecified` license discrepancy; RT terms/rate-limits undocumented.
- [Research: GTFS Static Ingestion & Query Approaches](tickets/003-gtfs-ingestion-research.md) — lean **`node-gtfs`/better-sqlite3 → read-only SQLite baked into the deploy artifact, cron rebuild-and-redeploy** for the ~6-week refresh; one query codepath across Docker (writable FS) and Vercel (read-only bundle). Fallback **Turso/libSQL** if the derived `.db` won't fit. RAPTOR/CSA trip-planning wants a separate in-memory timetable substrate (→ ticket 009, likely Docker-first). Hard constraint: better-sqlite3 works on Vercel Hobby only if compiled at build & queried read-only; **open unknown = derived `.db` size vs. Vercel bundle/cold-start budget — ticket 006 must measure it.**

## Not yet specified

<!-- fog: in scope, not yet sharp enough to ticket; graduates as the frontier advances -->

- **CI/CD & Docker deltas from GTFS ingestion** — the cloned go-planner CI/Docker specs assume a pure live-API server. Ingesting a GTFS ZIP likely adds a build-time (or scheduled) fetch/parse/bundle step and a ~6-week refresh mechanism. The exact shape can't be specified until *GTFS Ingestion & Storage Design* (006) resolves; graduates then.
- **Resources & Prompts roster** — go-planner ships static data as MCP Resources plus v1 Prompt templates. Whether TTC mirrors that (and which prompts) can't be pinned until the tool roster (005) is settled; graduates then.

## Out of scope

- **Unofficial data sources** — the reverse-engineered Bustime v3 prediction API (HMAC-signed, app credentials extracted from TTC's web client) and the ~20-year-old `myttc.ca` wrapper. Ruled out for a shippable v1: unsanctioned for third-party use / unreliable. Revisit only if the official GTFS-RT feed proves to lack needed arrival predictions.
- **The frontend app** (mobile + web) that will consume this MCP — separate future effort.
- **The backend** that will eventually orchestrate GO + TTC MCPs — deferred.
- **Per-user authentication** on the MCP server — self-hosters need no credentials; the official TTC feeds are keyless.

---

## Ticket Index

### Frontier (unblocked, open)

- [Task: Create ttc-mcp Repo & Deployment](tickets/002-create-repo.md) — HITL; repo + initial commit done, **only Vercel wiring remains** (package name settled by 004)
- [Grilling: MCP Tool & Primitive Roster](tickets/005-tool-roster.md) — unblocked (001 resolved)
- [Grilling: GTFS Ingestion & Storage Design](tickets/006-ingestion-storage-design.md) — unblocked (001 + 003 resolved)

### Blocked (open, waiting)

- [Grilling: Tool Schema & DTO Design](tickets/007-tool-schema-design.md) — blocked by 005
- [Grilling: GTFS-RT Real-time Integration & Cache Deltas](tickets/008-realtime-integration.md) — blocked by 005 (001 cleared)
- [Grilling: plan_trip — Multi-modal Transfer Routing](tickets/009-plan-trip-routing.md) — blocked by 005, 006, 007, 008 (the deferred capstone)

### Resolved

- [Grilling: Stack Baseline & Deltas from go-planner](tickets/004-stack-baseline.md) — clone go-planner verbatim + confirmed deltas; identity `ttc-mcp`; hosting decision deferred to 006 ([docs/spec/stack-baseline.md](../docs/spec/stack-baseline.md))
- [Research: TTC Feed & API Inventory](tickets/001-ttc-feed-inventory.md) — protobuf-only RT, real predictions, NO transfers.txt/fares/subway-RT, two datasets (35/81 MB); license discrepancy flagged
- [Research: GTFS Static Ingestion & Query Approaches](tickets/003-gtfs-ingestion-research.md) — lean node-gtfs/SQLite baked into deploy, Turso fallback; open unknown = derived `.db` size vs. Vercel budget (ticket 006 to measure)
