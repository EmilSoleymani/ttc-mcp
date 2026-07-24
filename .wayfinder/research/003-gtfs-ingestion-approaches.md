# RESEARCH 003 — GTFS Static Ingestion & Query Approaches for the TTC MCP Server

**Ticket type:** RESEARCH (survey only — no final decision)
**Date:** 2026-07-23
**Context:** TypeScript/Node MCP server, dual-hosted on **Vercel Hobby serverless** AND a **Docker container**. Ingests a GTFS *static* ZIP (stops/routes/trips/stop_times/calendar/…) and queries it at runtime. No live schedule API — all schedule answers come from the locally-ingested GTFS. GTFS ZIP refreshes ~every 6 weeks.

---

## TL;DR leaning

- **Docker** is the easy target: any embedded SQLite/DuckDB approach works with a normal writable FS.
- **Vercel Hobby** is the binding constraint. The cleanest single-codepath answer is **`node-gtfs` (better-sqlite3) with a pre-built, read-only SQLite file BUNDLED into the deploy artifact** — better-sqlite3 *does* compile and run on Vercel Node serverless functions, and read-only bundled `.db` querying is an explicitly supported pattern. The main risk is **bundle size** (TTC `stop_times` is large) against Vercel's function size limits + cold-start weight.
- The escape hatch if the DB is too big to bundle (or if you want zero divergence on the write path) is **Turso/libSQL** (edge SQLite over HTTP), which sidesteps the native-binary + ephemeral-FS problem entirely at the cost of a network hop and an external dependency.
- For the **eventual trip planner** (RAPTOR/CSA), no SQL substrate is the right runtime engine — those algorithms want **in-memory arrays** built once per service day. That is a separate concern from the ingest/query substrate and should not drive the substrate choice.

---

## 1. Libraries for ingesting / querying GTFS in Node/TS

| Library | What it does / storage | Maturity | TS support | Query ergonomics | Dep / runtime weight |
|---|---|---|---|---|---|
| **node-gtfs** (`gtfs`, BlinkTagInc) | Imports GTFS ZIP/CSV → **SQLite via better-sqlite3**. Default DB is **`:memory:`**; pass `sqlitePath` for a file. Ships typed query helpers. | Mature, active — ~500★, ~1000 commits, used by GTFS-to-HTML in production. MIT. | "Basic TypeScript typings included." Good enough; not exhaustively typed. | **Best out-of-box.** `getStops()`, `getRoutes()`, `getTrips()`, `getStoptimes()`, `getCalendars()`, `getCalendarDates()`, `getTransfers()`, `getShapes()`, plus spatial/GeoJSON helpers. Each takes a query object → covers most tool needs without hand-written SQL. | Native addon (better-sqlite3) + import pipeline. Moderate. |
| **gtfs-via-postgres** (public-transport) | Imports GTFS → **PostgreSQL** (generates SQL/views). Runtime access is **SQL-only** (no helper API). | Mature, well-maintained. | N/A (it's a schema/SQL generator; you write queries). | Powerful analytical SQL + prebuilt views, but you own all query code. | **Heavy for serverless** — needs a Postgres daemon. Fine for Docker + external managed PG (Neon). |
| **gtfs-via-duckdb** (public-transport) | Fork / "spiritual successor" of gtfs-via-postgres → single-file **DuckDB**. Same design, SQL-only runtime. | Newer but same lineage/maintainer. | N/A (SQL). | Same SQL model; OLAP-optimized so imports + analytic queries run faster than PG. No daemon — DB is one file. | **DuckDB native addon** (`duckdb`/`@duckdb/node-api`). Larger native binary than SQLite; column-store shines for analytics, less ideal for tiny point lookups. |
| **DuckDB (duckdb-node) raw** | Query GTFS CSV/Parquet directly or after load; single-file DB. | Mature engine. | Typed client available. | Excellent for aggregate/analytic queries and reading CSV/Parquet directly. You write SQL. | Native binary heavier than better-sqlite3; serverless bundling concerns similar to (or worse than) better-sqlite3. |
| **csv-parse + hand-rolled better-sqlite3** | You parse CSVs and build your own schema/indexes. | You own it. | Full control → fully typed if you write the types. | Whatever you build. Max control over schema & indexes tuned to the exact tool queries. | Same native better-sqlite3 dependency, minus node-gtfs's helpers. More build effort. |
| **Pure in-memory maps** | Parse CSVs into JS `Map`/arrays; no DB. | You own it. | Fully typed. | Trivial point lookups; **joins/date-service logic are all hand-written**. Great for the RAPTOR engine, painful for ad-hoc queries. | Zero native deps. **Memory-bound** — a full TTC `stop_times` in JS objects is many hundreds of MB; problematic on serverless memory limits and cold-start parse time. |

**Read:** `node-gtfs` is the pragmatic default — it *is* better-sqlite3 under the hood, so choosing it doesn't lock you out of raw SQL, and it removes the import/query boilerplate. DuckDB is the stronger analytics engine but adds a heavier native binary and gives no helper API. Pure-in-memory is the wrong primary substrate but the *right* structure for the future trip planner.

Sources: [node-gtfs](https://github.com/BlinkTagInc/node-gtfs), [gtfs npm](https://www.npmjs.com/package/gtfs), [gtfs-via-postgres](https://github.com/public-transport/gtfs-via-postgres), [gtfs-via-duckdb](https://github.com/public-transport/gtfs-via-duckdb), [GTFS + DuckDB-Wasm](https://saadiqm.com/2023/09/26/gtfs-parquet-duckdb.html)

---

## 2. Storage substrate given the two hosting targets

### The Vercel constraints (the crux)
- **Ephemeral, largely read-only FS.** No persistent server-side filesystem; `/tmp` is writable but **per-instance and ephemeral**, and each cold instance gets its own empty `/tmp` with no shared state. ([Vercel: is SQLite supported](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel), [stackcompat](https://www.stackcompat.dev/sqlite-with-vercel/))
- **4.5 MB response body cap** on functions (request *and* response). Query results must be paginated/trimmed well under this; streaming functions are exempt if ever needed. ([Vercel Functions Limits](https://vercel.com/docs/functions/limitations), [bypass 4.5MB](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions))
- **Cold starts + scale-to-zero.** Anything loaded/parsed at cold start adds latency to the first request per instance.
- **Function bundle size limits** (Hobby): deployed function unzipped size is capped (~250 MB unzipped incl. deps). A large bundled `.db` competes with this budget and inflates cold-start.
- **Native module support:** Vercel **compiles native modules during build** on its Linux build image, so **better-sqlite3 installs and runs in Node.js serverless functions.** The classic "invalid ELF header" failures come from shipping a locally-built (macOS/Windows) binary into a Linux Lambda — avoided by letting Vercel build it, not vendoring `node_modules`. ([stackcompat](https://www.stackcompat.dev/sqlite-with-vercel/), [better-sqlite3 #819 cross-platform](https://github.com/WiseLibs/better-sqlite3/issues/819), [better-sqlite3 #343 lambda](https://github.com/WiseLibs/better-sqlite3/issues/343))

### Options for where the parsed GTFS DB lives

| Option | How it works | Vercel viability | Notes / risks |
|---|---|---|---|
| **(a) SQLite file BUNDLED read-only into deploy artifact** | Pre-build the `.db` at CI/build time, commit or generate it, ship it in the function bundle, open **read-only** at runtime with better-sqlite3. | **Yes — the recommended serverless SQLite pattern.** better-sqlite3 compiles on Vercel; bundled read-only `.db` is explicitly supported for "reference data that changes infrequently" — which is exactly GTFS static. | Guidance suggests keeping bundled DBs **~5–10 MB** to avoid cold-start latency; larger needs a hosted DB. **TTC `stop_times.txt` is big** → the derived SQLite may exceed that comfort zone. Mitigate by pruning columns/indexes, or by narrowing the schema. Fast cold start once loaded (mmap, no network). ([stackcompat](https://www.stackcompat.dev/sqlite-with-vercel/), [codenote embedded DB comparison](https://codenote.net/en/posts/vercel-nextjs-embedded-database-prototyping/), [vercel/community #1181 read-only sqlite](https://github.com/vercel/community/discussions/1181)) |
| **(b) Hydrate to `/tmp` on cold start** | On cold start, download the ZIP/DB and ingest/write into `/tmp`, then query. | Works but **pays ingest cost on every cold start**, per instance, and `/tmp` is wiped when the instance recycles. | Cold-start latency + repeated work + memory pressure. Only sane if the DB is small and downloaded pre-built (not re-ingested from CSV each time). Generally inferior to (a) for static data. |
| **(c) External hosted DB** — **Turso/libSQL** (edge SQLite over HTTP) or **Neon/Postgres** | DB lives off-box; function queries it over HTTP/fetch. | **Yes, and it dodges both native-binary and ephemeral-FS issues.** Turso's `@libsql/client` uses a **fetch-based protocol** (no persistent TCP), purpose-built for serverless/edge; API aims to be **better-sqlite3-compatible**. Neon is serverless Postgres over HTTP. | Adds a network hop per query + an external service + credentials. Turso has a Vercel Marketplace integration and a free tier (hundreds of DBs). libSQL keeps you in SQLite/SQL land, so a Docker build can point the *same code* at a local libSQL/SQLite file → **low codepath divergence.** ([Turso serverless driver](https://turso.tech/blog/introducing-turso-serverless-javascript-driver), [Turso on Vercel Functions](https://turso.tech/blog/serverless), [Turso Cloud for Vercel](https://vercel.com/marketplace/tursocloud), [libsql-js README](https://github.com/tursodatabase/libsql-js)) |
| **(d) Pre-derived JSON blobs** | Bake per-query JSON (e.g. per-stop schedule slices) at build time; serve statically. | Works for a fixed, known query set; no DB engine at runtime. | Inflexible — can't answer arbitrary joins; explodes in size for full schedule; poor fit for a trip planner. Fine only as a cache layer for hot endpoints. |

### Serving BOTH targets without divergent codepaths
Two clean strategies:

1. **SQLite-file everywhere.** Use `node-gtfs`/better-sqlite3 against a **pre-built `.db`**. Docker builds/refreshes the file on a writable FS; Vercel ships the same file read-only in the bundle. **Same query code, same engine**; only the "where does the file come from / is it writable" differs (build step vs. bundled). This is the lowest-divergence option *if the DB fits the bundle budget.*
2. **libSQL everywhere.** Code against `@libsql/client`. Vercel → Turso over HTTP; Docker → a local libSQL/SQLite file (or a co-located Turso/`sqld`). **Identical query code**, substrate swapped by connection string/env. Removes the bundle-size ceiling and the native-binary question, at the cost of a hosted dependency for the Vercel path.

**better-sqlite3 native-binary caveat, explicitly:** it works on Vercel *because Vercel builds it during deploy*. Do **not** vendor a prebuilt binary from a dev machine — that's the "invalid ELF header" trap. **Turso/libSQL avoids the native-binary bundling question entirely** on the serverless side (fetch-based client), which is its main architectural selling point here.

---

## 3. Refresh model (GTFS ZIP updates ~every 6 weeks)

| Model | Mechanism | Vercel fit | Docker fit | Trade-offs |
|---|---|---|---|---|
| **Rebuild + redeploy on a cron** (data baked into artifact) | CI job (GitHub Actions / Vercel Cron trigger) fetches the ZIP, builds the `.db` (or pushes rows to Turso), redeploys. | **Best fit for the ephemeral-FS constraint.** No runtime writes; data is immutable per deploy; atomic swap on deploy. | Rebuild image on the same cron, or ingest at container start. | Simple, atomic, cache-friendly. 6-week cadence + a manual trigger is plenty; a weekly cron with last-modified check catches off-cycle updates. Requires a build pipeline. |
| **Runtime re-ingest on a schedule** | Function/worker periodically pulls ZIP and rebuilds the DB. | **Poor on Vercel** — nowhere durable to write (ephemeral `/tmp`, per-instance), and scale-to-zero means no reliable background worker. | Fine in Docker (a long-lived process can re-ingest to disk). | Diverges the two targets; fights Vercel's model. Avoid on Vercel. |
| **Lazy last-modified check + refresh** | On request (or via cron), HEAD the feed; if `Last-Modified`/ETag changed, re-ingest. | On Vercel this only makes sense if the refresh **targets an external DB (Turso/Neon)**, not local FS. Against a bundled file it can't mutate the artifact. | Works in Docker. | Good for the Turso/external-DB path (one writer updates the shared DB, all instances see it). Pointless for bundled-file Vercel. |

**Read:** With the **bundled-file** substrate → **rebuild+redeploy on a cron** is the natural refresh story and the only one that respects Vercel's read-only/ephemeral FS. With the **Turso/external-DB** substrate → a scheduled **last-modified check that re-ingests into the shared DB** works for both targets uniformly. TTC's ~6-week cadence makes either cheap.

---

## 4. Query patterns the tools need

1. **Stop lookup by id / name** — trivial on any substrate (indexed `stops` lookup / `Map`).
2. **Routes serving a stop** — `stop_times → trips → routes` join, or precomputed stop→routes index. Fine in SQLite/DuckDB with proper indexes.
3. **Next scheduled trips at a stop for a service day** — the load-bearing query: join `stop_times` × `trips` × (`calendar` + `calendar_dates` exceptions), filter by service date + departure ≥ now, order by time, limit. **Needs indexes on `stop_times(stop_id, departure_time)` and `trips(service_id)`.** Well-suited to SQLite (`node-gtfs` has helpers; or hand SQL). DuckDB also fine. **Pure in-memory** requires you to hand-build these joins/indexes.
4. **Graph / transfer queries → multi-modal trip planner (RAPTOR/CSA)** — this is **not a SQL workload.** RAPTOR/CSA want the timetable loaded into **flat in-memory arrays** (stops, routes, stop_times, transfers) and iterate rounds; hitting SQL per round is pathological. Practical pattern: **use the SQL substrate as the durable/queryable store, and build an in-memory timetable snapshot per service day for the planner.** Libraries: `planarnetwork/raptor` (works with any well-formed GTFS), `minotor` (client/Node RAPTOR, serializes data to protobuf, all-day-in-memory). RAPTOR generally gives higher-quality journeys than CSA (fewer spurious transfers). ([planarnetwork/raptor](https://github.com/planarnetwork/raptor), [minotor](https://github.com/aubryio/minotor), [RAPTOR explainer](https://ljn.io/posts/raptor-journey-planning-algorithm))

**Substrate implication:** For tools 1–3, SQLite (node-gtfs) is more than adequate and avoids pathological queries with the right indexes. Tool 4 argues for keeping the option to **materialize an in-memory snapshot** — which is easy from *any* file/DB substrate, and is memory-heavy on serverless (a reason the planner may end up **Docker-first / warm-instance-first**, with the serverless target focused on tools 1–3).

---

## 5. RECOMMENDATION MATRIX

| Approach | Vercel-viable | Docker-viable | Refresh story | Trip-planner readiness | Effort |
|---|---|---|---|---|---|
| **node-gtfs + bundled read-only SQLite** | **Yes**, if DB fits bundle/cold-start budget (~watch `stop_times` size). Native module builds on Vercel; read-only pattern supported. | **Yes** (build/refresh file on writable FS). | Rebuild + redeploy on cron. Clean, atomic, FS-safe. | Good for 1–3. Planner = build in-memory snapshot from the file (heavy on serverless). | **Low** — helpers included; lowest codepath divergence *if it fits*. |
| **node-gtfs / better-sqlite3 hydrate to `/tmp`** | Marginal — cold-start ingest per instance; `/tmp` ephemeral. | Yes but pointless vs. building on disk. | Re-download/ingest on cold start (wasteful) or cron. | Same as above but worse cold starts. | Medium; not recommended for Vercel. |
| **Turso / libSQL (edge SQLite over HTTP)** | **Yes — strongest serverless fit.** fetch-based, no native binary, no FS. Free tier + Vercel integration. | Yes (local libSQL/SQLite file, same client). | Scheduled last-modified re-ingest into shared DB; both targets see updates. | Good for 1–3 over HTTP (per-query latency). Planner still wants in-memory snapshot pulled from DB. | **Low–Medium** — add client + external service + creds; near-zero divergence. |
| **DuckDB (single-file)** | Possible but heavier native binary; less proven serverless bundling; better for analytics than point lookups. | **Yes, excellent** (fast import, single file, no daemon). | Rebuild file on cron. | Analytics-strong; still export to in-memory for RAPTOR. | Medium — SQL-only, no helper API. |
| **gtfs-via-postgres + Neon (serverless PG)** | Yes via Neon HTTP driver. | Yes (local PG or Neon). | Cron re-ingest into PG. | Full SQL power for 1–3; planner still in-memory. | **Higher** — you write all queries + schema ops; heaviest infra. |
| **Pure in-memory maps** | Risky — big memory + cold-start parse; may exceed serverless memory for full TTC `stop_times`. | Yes (warm process). | Re-parse on refresh. | **Best for RAPTOR/CSA**, worst for ad-hoc joins. | Medium–High — hand-build every join/index. |
| **Pre-derived JSON blobs** | Yes for fixed hot endpoints only. | Yes. | Rebuild blobs on cron. | Poor — inflexible, no arbitrary joins. | Low for a fixed set; doesn't scale to planner. |

---

## 6. Leaning (not a decision)

- **If the derived TTC SQLite comfortably fits the bundle/cold-start budget** → **node-gtfs + bundled read-only SQLite**, refreshed by **rebuild-and-redeploy on a cron**. Single engine, single query code, works on both targets, no external dependency. *Verify the actual `.db` size against Vercel's function-size + cold-start budget early — this is the make-or-break unknown given TTC `stop_times` volume.*
- **If it does not fit (or you want to unify the write/refresh path across targets)** → **Turso/libSQL**, which removes both the native-binary bundling question and the ephemeral-FS problem via a fetch-based client, with a local libSQL file giving Docker the same code.
- **Keep the trip planner (RAPTOR/CSA) as a separate concern:** whatever the substrate, plan to **materialize an in-memory timetable snapshot per service day** for routing; this likely lands **Docker-first / warm-instance-first** due to serverless memory + cold-start limits.

### The single biggest constraint
**Vercel Hobby's ephemeral, read-only filesystem + the native-SQLite question.** better-sqlite3 *does* work on Vercel — but only because Vercel **compiles it during build** (never vendor a prebuilt binary → "invalid ELF header"), and only in **read-only, bundled-file** mode, since there is no durable writable FS (`/tmp` is per-instance and ephemeral). That forces the data to be either **baked into the deploy artifact** (bounded by function size + cold-start budget — the open question against TTC `stop_times`) or **externalized to an HTTP DB like Turso/libSQL**, which is the specific technology that sidesteps both the native-binary and the ephemeral-FS problems.

---

## Sources
- node-gtfs — https://github.com/BlinkTagInc/node-gtfs · npm https://www.npmjs.com/package/gtfs
- gtfs-via-postgres — https://github.com/public-transport/gtfs-via-postgres
- gtfs-via-duckdb — https://github.com/public-transport/gtfs-via-duckdb
- GTFS + DuckDB-Wasm — https://saadiqm.com/2023/09/26/gtfs-parquet-duckdb.html
- Is SQLite supported in Vercel — https://vercel.com/kb/guide/is-sqlite-supported-in-vercel
- Does SQLite Work With Vercel (stackcompat) — https://www.stackcompat.dev/sqlite-with-vercel/
- Vercel read-only sqlite discussion — https://github.com/vercel/community/discussions/1181
- Embedded DB prototyping on Vercel (codenote) — https://codenote.net/en/posts/vercel-nextjs-embedded-database-prototyping/
- better-sqlite3 cross-platform issue #819 — https://github.com/WiseLibs/better-sqlite3/issues/819
- better-sqlite3 AWS lambda issue #343 — https://github.com/WiseLibs/better-sqlite3/issues/343
- Vercel Functions Limits — https://vercel.com/docs/functions/limitations
- Vercel 4.5MB body limit — https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions
- Turso serverless JS driver — https://turso.tech/blog/introducing-turso-serverless-javascript-driver
- Turso on Vercel Functions — https://turso.tech/blog/serverless
- Turso Cloud for Vercel — https://vercel.com/marketplace/tursocloud
- libsql-js — https://github.com/tursodatabase/libsql-js
- planarnetwork/raptor — https://github.com/planarnetwork/raptor
- minotor (RAPTOR, Node/browser) — https://github.com/aubryio/minotor
- RAPTOR explainer — https://ljn.io/posts/raptor-journey-planning-algorithm
