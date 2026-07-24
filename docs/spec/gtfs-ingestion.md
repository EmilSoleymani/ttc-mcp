# GTFS Ingestion & Storage Design

**Status:** accepted (wayfinder ticket 006, 2026-07-23)
**Crux ticket** — TTC has no live schedule API, so the server ingests, stores, and queries the GTFS static feed itself. This spec is grounded in an **empirical measurement** of the derived DB (see below), not estimates.

## The measurement that drove the design

Built the real DB from Dataset A (`opendata_ttc_schedules.zip`, 35 MB; `stop_times` = 4.2 M rows / ~200 MB uncompressed):

| Build | Size | gzipped |
|---|---|---|
| Naïve all-TEXT + shapes | 488 MB | 104 MB |
| Naïve all-TEXT, no shapes | 468 MB | 98 MB |
| **Optimized typed, no shapes, indexed** | **237 MB** | 87 MB |

Optimized = integer times (seconds-since-midnight), integer surrogate keys, essential columns only, targeted indexes. Query plan for "next departures at a stop" confirmed to use `ix_st_stop_dep`.

**Conclusion:** even optimized, 237 MB + `node_modules` **exceeds Vercel's ~250 MB uncompressed function budget** → baking the DB into a Vercel function is not viable. `node-gtfs`'s TEXT-heavy schema ≈ the 468 MB case, so it's out (Docker-only otherwise). This forced the substrate choice.

## Decisions

### 1. Substrate — Turso / libSQL (unified)

The optimized DB lives in **Turso** (hosted libSQL). One `@libsql/client` codepath serves both targets:

- **Vercel:** queries **remote Turso** over HTTP — no bundle-size limit, no native-binary concern. Keeps Vercel first-class (honors [stack-baseline](./stack-baseline.md) ticket-004 decision).
- **Docker:** an **embedded local libSQL file** (`file:/data/ttc.db`) baked at image-build time — self-contained, zero external dependency for self-hosters. May alternatively point at a remote Turso via config.

`node-gtfs` is **not** used — a hand-rolled thin repository over the optimized schema instead.

### 2. Optimized schema (authoritative shape)

Typed tables, integer surrogate keys (TTC `stop_id`/`trip_id`/`route_id` are numeric), times as **INTEGER seconds-since-midnight** (handles >24:00:00 GTFS times natively):

- `stops(stop_id PK, stop_code, stop_name, stop_lat, stop_lon, parent_station)`
- `routes(route_id PK, route_short_name, route_long_name, route_type)`
- `trips(trip_id PK, route_id, service_id, direction_id, shape_id)`
- `stop_times(trip_id, stop_id, stop_sequence, arr INT, dep INT)` — only essential columns
- `calendar`, `calendar_dates`
- **`pathways`, `levels`** — from Dataset B, for the subway in-station interchange graph
- **`transfers(from_stop_id, to_stop_id, min_walk_seconds, type)`** — **synthesized at ingest** (ticket 009), the manufactured `transfers.txt`: `station` (shared parent_station), `pathway` (from B's pathways/levels), `street` (proximity ≤ ~250 m, haversine ÷ ~1.3 m/s). Indexed on `from_stop_id`; consumed by `plan_trip`.
- **shapes: excluded from v1** (no tool consumes geometry; trivially addable later for a frontend)

Indexes: `stop_times(stop_id, dep)`, `stop_times(trip_id, stop_sequence)`, `trips(route_id)`, `stops(stop_code)`, `calendar_dates(service_id, date)`, plus `pathways` interchange lookups.

### 3. Feeds ingested (two sources)

- **Dataset A** (`opendata_ttc_schedules.zip`, ~6-week refresh) → all schedule tables. Canonical, freshest schedules.
- **Dataset B** (`completegtfs.zip`, quarterly) → **only `pathways.txt` + `levels.txt`** for subway station interchange graphs (compensates for the absent `transfers.txt`).

Both resolved via CKAN `package_show` → `resources[0].url` / `.last_modified` (stable resource UUIDs; see ticket 001 report for the exact URLs).

### 4. Ingest pipeline

A Node ingest script (`scripts/ingest.ts`): downloads both ZIPs → **streams** the CSVs (stop_times is 4.2 M rows — must stream, never load in memory) → builds the optimized libSQL DB → **generates the synthetic `transfers` table** (station/pathway/street derivation, ticket 009) → syncs to Turso (remote) or writes the local file (Docker build). Same script drives both CI refresh and the Docker image build.

### 5. Refresh model — scheduled cron + change poll

A GitHub Actions **cron (weekly)** calls CKAN `package_show` for both datasets, compares `last_modified`/`ETag` against the last-ingested version, and **rebuilds + pushes to Turso only on change** (no-op otherwise). Owner's Vercel sees new data immediately (shared Turso). Self-hosters refresh by re-running `scripts/ingest.ts` or pulling a new Docker image (which re-bakes the local file). **Graduates the map's "CI/CD & Docker deltas" fog line** into this concrete workflow — no separate ticket needed.

### 6. Config surface (env vars)

| Var | Purpose | Vercel | Docker | CI |
|---|---|---|---|---|
| `LIBSQL_URL` | connection: `libsql://…turso.io` or `file:/data/ttc.db` | remote | local file | — |
| `LIBSQL_AUTH_TOKEN` | Turso auth (remote only) | ✅ **secret** | — | — |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | ingest job pushes refreshes | — | — | ✅ **secret** |
| `GTFS_SCHEDULES_URL`, `GTFS_MERGED_URL` | overridable feed URLs (default to CKAN resource URLs) | opt | opt | opt |

**Ripple to other tickets:** the TTC feeds stay keyless, but **Turso reintroduces secrets** — `LIBSQL_AUTH_TOKEN` for Vercel and Turso creds in CI. This amends ticket 002's "no secret" note and the [stack-baseline](./stack-baseline.md) CI/CD delta (the "− no secret" line becomes "− no *TTC* secret; + Turso creds").

## Query layer

A thin repository (`src/gtfs/*`) over `@libsql/client` exposing the operations the tools need: stop/route lookup by id & code, name search, **next-departures-at-stop for a service day** (join `stop_times`+`trips`+`calendar`/`calendar_dates`, indexed), and the timetable + `pathways`-based interchange queries **`plan_trip` (ticket 009)** will build on. Service-day resolution honors `calendar` + `calendar_dates` exceptions.

## Hand-offs
- **Ticket 002:** add `LIBSQL_URL` + `LIBSQL_AUTH_TOKEN` to Vercel; the repo/CI needs Turso creds.
- **Ticket 007:** DTOs surface integer-seconds times as ISO/clock strings; IDs are the numeric GTFS ids.
- **Ticket 009:** `plan_trip` builds on the timetable + `pathways`/`levels` interchange graph (no `transfers.txt`).
