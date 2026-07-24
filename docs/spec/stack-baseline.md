# Stack Baseline & Deltas from go-planner

**Status:** accepted (wayfinder ticket 004, 2026-07-23)
**Decision:** `ttc-mcp` clones `go-planning-mcp`'s stack **wholesale**. This document is the authoritative record of what is inherited verbatim and the TTC-specific **deltas**. Where a delta is not yet fully specified, it links the ticket that will resolve it.

Baseline source of truth: [`go-planning-mcp/docs/spec/`](https://github.com/EmilSoleymani/go-planning-mcp) (project-architecture, test-architecture, cicd-pipeline, docker-deployment, caching-rate-limiting) and its ADR-0001.

## Identity

- **Repo:** `ttc-mcp` (public, MIT, default branch `main`)
- **npm package:** `ttc-mcp`
- **Container image:** `ghcr.io/emilsoleymani/ttc-mcp`
- **Publish trigger:** `v*` tags → dual publish to npm + ghcr (inherited from go-planner's tag-triggered pattern)
- **Node baseline:** inherited verbatim — Node ≥ 20, CI matrix `[20, 22]`
- **Language/runtime:** TypeScript, pure ESM, strict TS (NodeNext/ES2022), `tsc`-only build with `tsx` dev
- **Transports:** stdio + Streamable HTTP via transport-agnostic `buildServer()`
- **License:** MIT © 2026 Emil Soleymani

## Inheritance & delta table

| go-planner spec | Inherited | TTC delta |
|---|---|---|
| **Project architecture** — ESM, strict TS, `tsc`-only, transport-agnostic `buildServer()`, one file per tool, native `fetch` | verbatim | **+ protobuf dependency** (GTFS-RT is protobuf-only — `?format=json` ignored; ticket 001) — decode lib chosen in [ticket 008]. **+ GTFS-ingestion dependencies** (leaning `node-gtfs`/`better-sqlite3`; ticket 003) — finalized in [ticket 006]. go-planner's "GTFS-RT as JSON, no protobuf dep" does **not** carry over. |
| **Test architecture** — msw at HTTP seam, hand-built fake client, captured-real JSON fixtures + refresh script, 80/70 coverage, schema-validated smoke, two-tier manual checklist | verbatim | **+ a GTFS static ZIP fixture** and **+ a protobuf GTFS-RT fixture** join the captured-fixtures set. Smoke must exercise: the static feed download, all three RT feeds, and (once built) the ingested query layer. |
| **CI/CD pipeline** — keyless PR checks, Vercel built-in Git integration, weekly smoke cron with `gh`-CLI auto-issue, single-secret model, squash-only merges + phased branch protection | verbatim | **− no `*_API_KEY` secret** (TTC feeds are keyless — the whole secret block is dropped). **+ a GTFS-refresh mechanism** (the feed updates ~every 6 weeks) — most likely a scheduled rebuild-and-redeploy workflow; exact shape TBD in [ticket 006], graduates the map's "CI/CD & Docker deltas" fog line. |
| **Docker & deployment** — `node:22-alpine` multi-stage, non-root, liveness `/health`, fail-fast env contract, run-only compose, four-block self-hoster README, ghcr+npm tag-triggered publish, `RELEASING.md` | verbatim | **+ the image must obtain the GTFS data** (bake a derived SQLite file at build time and/or fetch on start) — TBD in [ticket 006]. Env contract changes: no API key; new vars will concern the feed URL / DB path / refresh toggle (also TBD in 006, feeds back to ticket 002). Image name `ttc-mcp`. |
| **Caching & retry** — ADR-0001 conservative retry (2 retries on network/5xx, 429 never retried, full-jitter backoff); in-process TTL cache (stops 24h, schedules 6h, real-time never) | verbatim | The **6h "schedule" TTL is moot** — TTC schedules are a **local ingested DB**, not a remote call; freshness is governed by the GTFS-refresh model (ticket 006), not an HTTP TTL. Retry policy applies unchanged to the static-feed download + the three RT endpoints. RT cache TTLs (likely a short coalescing window vs. never-cache) are decided in [ticket 008]. |

## Hosting posture

Inherit go-planner's **dual first-class targets: Vercel Hobby + Docker** (self-host). **Watch-item:** TTC's GTFS ingestion produces a multi-MB derived SQLite DB, and Vercel's serverless filesystem is ephemeral/read-only. Whether Vercel remains viable — a build-time-baked read-only `.db` — vs. requiring the Turso/libSQL fallback is **decided in [ticket 006]** by measuring the derived `.db` size (source feeds are 35 MB / 81 MB) against Vercel's function-size + cold-start budget. Docker (writable FS) is unconstrained either way. If the measurement kills bake-in and Turso is rejected, the fallback posture is **Docker-first, Vercel best-effort** — but that is not the decision today.

## What this ticket does NOT decide (downstream)

- Exact ingestion/storage substrate, GTFS-refresh workflow shape, Docker data-baking, and the derived-`.db` measurement → **[ticket 006]**
- GTFS-RT protobuf decode library + RT cache TTLs → **[ticket 008]**
- Tool/resource/prompt roster and schemas → **tickets 005, 007**
- `plan_trip` routing → **ticket 009**

[ticket 006]: ../../.wayfinder/tickets/006-ingestion-storage-design.md
[ticket 008]: ../../.wayfinder/tickets/008-realtime-integration.md
[ticket 005]: ../../.wayfinder/tickets/005-tool-roster.md
[ticket 007]: ../../.wayfinder/tickets/007-tool-schema-design.md
[ticket 009]: ../../.wayfinder/tickets/009-plan-trip-routing.md
