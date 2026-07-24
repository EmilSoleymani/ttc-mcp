---
id: "004"
title: "Grilling: Stack Baseline & Deltas from go-planner"
type: grilling
status: open
blocked_by: []
blocks: []
---

## Question

The user chose to **clone go-planner's stack wholesale**. This ticket records exactly what that means so the implementation agent has an unambiguous baseline, and enumerates the TTC deltas — the places where TTC genuinely diverges. Work one question at a time.

Confirm, per go-planner spec, which are **adopted verbatim** vs. **adapted**:
1. **Project architecture** (`go-planning-mcp/docs/spec/project-architecture.md`) — pure ESM + strict TS, `tsc`-only build with `tsx` dev, transport-agnostic `buildServer()`, one file per tool, native `fetch`. Adopt verbatim? **CONFIRMED delta (ticket 001): TTC GTFS-RT is protobuf-only (`?format=json` ignored), so a `protobufjs`/`gtfs-realtime-bindings` dependency IS forced** — unlike go-planner's JSON approach. This spec's dependency list changes; also adds a GTFS-ingestion dep set (better-sqlite3/node-gtfs per ticket 003).
2. **Test architecture** (`test-architecture.md`) — msw at the HTTP seam, fake client for tools, captured-real JSON fixtures, 80/70 coverage, schema-validated smoke. Adopt verbatim? Delta: fixtures now include a **GTFS ZIP fixture** and a protobuf RT fixture.
3. **CI/CD** (`cicd-pipeline.md`) — keyless PR checks, Vercel Git integration, smoke cron + auto-issue, squash-only. Adopt verbatim? Delta: **no `METROLINX_API_KEY` secret**; a GTFS-refresh mechanism may add a scheduled workflow (fog — graduates from ticket 006).
4. **Docker & deployment** (`docker-deployment.md`) — node:22-alpine multi-stage, run-only compose, ghcr + npm tag-triggered publish, RELEASING.md. Adopt verbatim? Delta: image may need to **bake in / fetch the GTFS data** (fog — graduates from ticket 006).
5. **Caching & retry** (ADR-0001, `caching-rate-limiting-spec.md`) — conservative retry, in-process TTL cache (stops 24h, schedules 6h, real-time never). Adopt verbatim? Delta: TTC "schedules" are a local GTFS DB, not a remote call — the 6h schedule TTL becomes a GTFS-refresh concern instead; RT TTLs still apply (detailed in ticket 008).

**Deliverable:** a short `docs/spec/stack-baseline.md` (in the ttc-mcp repo) that says "inherits go-planner's X spec, with these deltas: …" for each of the five, so nothing is silently assumed. Anything still unknown links to the ticket that will resolve it.

## Answer
