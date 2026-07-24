---
id: "003"
title: "Research: GTFS Static Ingestion & Query Approaches"
type: research
status: resolved
blocked_by: []
blocks: ["006"]
---

## Question

Survey the approaches for **ingesting and querying a GTFS static feed at runtime** so the ingestion/storage design ticket (006) has concrete options to choose between. This is knowledge external to the repo; keep it approach-agnostic to TTC specifics (which ticket 001 supplies).

Investigate and compare:
1. **Libraries** — `node-gtfs` (imports GTFS into SQLite, ships query helpers), `gtfs-to-sql`, raw csv-parse + hand-rolled SQLite, DuckDB, in-memory maps. Maturity, query ergonomics, bundle weight, TS support.
2. **Storage substrate** given the cloned hosting (Vercel Hobby serverless + Docker):
   - Vercel functions have an **ephemeral, read-only-ish filesystem** and a 4.5 MB body cap, cold starts, scale-to-zero. Where does a multi-MB parsed GTFS DB live? Options to survey: SQLite file **bundled into the deploy artifact at build time** (read-only queries at runtime), `/tmp` hydration on cold start, an external hosted DB (Turso/libSQL, Postgres), or querying pre-derived JSON.
   - Docker self-host has a normal filesystem — a build-time or first-run ingest to a local SQLite file is trivial there. The design must serve **both** targets.
3. **Refresh model** — the ZIP changes ~every 6 weeks. Survey: rebuild+redeploy on a cron (data baked into the image/deploy), vs. runtime re-ingest on a schedule, vs. checking `last_modified` and lazy-refreshing. Trade-offs against the ephemeral-FS constraint.
4. **Query patterns the tools need** — stop lookup by id/name, routes at a stop, next scheduled trips at a stop for a service day (requires joining `trips`+`stop_times`+`calendar`/`calendar_dates`), and the transfer/graph queries `plan_trip` (009) will eventually need. Which substrate serves these without pathological queries?

**Deliverable:** findings report at `.wayfinder/research/003-gtfs-ingestion-approaches.md` with a recommendation matrix (approach × Vercel-viable / Docker-viable / refresh-story / plan_trip-readiness). Do not decide — surface the trade-offs for ticket 006.

## Answer

Resolved by subagent 2026-07-23. Full report: [`../research/003-gtfs-ingestion-approaches.md`](../research/003-gtfs-ingestion-approaches.md).

- **Primary leaning: `node-gtfs` (better-sqlite3) → a pre-built read-only SQLite file bundled into the deploy artifact**, refreshed by rebuild-and-redeploy on a cron. One engine, one query codepath across both targets: Docker builds the `.db` on a writable FS; Vercel ships the same file read-only. Lowest effort; ships helper queries for stop/route/next-trip lookups.
- **Fallback / unifier: Turso/libSQL (edge SQLite over HTTP)** — a fetch-based client removes both the native-binary bundling question and the ephemeral-FS problem; a local libSQL file gives Docker identical code. Use if the derived DB is too big to bundle.
- **Trip planner (RAPTOR/CSA) is a separate substrate concern** — wants an in-memory timetable snapshot per service day, not SQL-per-round; likely Docker-first due to serverless memory/cold-start limits. Feeds directly into ticket 009.
- **The make-or-break constraint:** better-sqlite3 works on Vercel Hobby *only* because Vercel compiles it at build (never vendor a prebuilt binary → "invalid ELF header"), and *only* in read-only bundled-file mode (`/tmp` is ephemeral/per-instance). So data is either baked into the deploy artifact — bounded by Vercel's function-size + cold-start budget, the **open unknown vs. TTC's large `stop_times`** — or externalized to Turso. **Next concrete step for ticket 006: measure the actual derived `.db` size against Vercel's bundle/cold-start budget.**
