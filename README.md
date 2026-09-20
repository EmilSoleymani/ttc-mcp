# ttc-mcp

[![CI](https://github.com/EmilSoleymani/ttc-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/EmilSoleymani/ttc-mcp/actions/workflows/ci.yml)
[![Publish](https://github.com/EmilSoleymani/ttc-mcp/actions/workflows/publish.yml/badge.svg)](https://github.com/EmilSoleymani/ttc-mcp/actions/workflows/publish.yml)
[![Smoke](https://github.com/EmilSoleymani/ttc-mcp/actions/workflows/smoke.yml/badge.svg)](https://github.com/EmilSoleymani/ttc-mcp/actions/workflows/smoke.yml)
[![npm](https://img.shields.io/npm/v/ttc-mcp)](https://www.npmjs.com/package/ttc-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **Toronto Transit Commission (TTC)**. Exposes subway, streetcar, and bus schedules, live vehicle positions, real-time arrivals, and service alerts to LLM clients — plus multi-modal trip planning with transfers.

Built entirely on TTC's **official open feeds** — no API key required:

- **Static GTFS** (routes, stops, schedules) from [open.toronto.ca](https://open.toronto.ca/dataset/ttc-routes-and-schedules)
- **GTFS-Realtime** (vehicle positions, trip updates, service alerts) from `bustime.ttc.ca`

TypeScript · stdio + Streamable HTTP transports · self-hostable via Docker or Vercel.

Sibling project to [go-planning-mcp](https://github.com/EmilSoleymani/go-planning-mcp) (GO Transit / Metrolinx).

> **Status: in active development.** Tracked via a wayfinder map under [`.wayfinder/`](./.wayfinder/map.md) — most of the static-schedule surface (stops, routes, schedules), real-time tools, and `plan_trip` are implemented. See the repo's open issues for exact status.

## Scope notes

- Real-time coverage (live positions & arrivals) is **bus + streetcar only** — TTC does not publish subway real-time. Subway is served from the static schedule plus service alerts.
- Fares are a flat PRESTO fare with a 2-hour transfer window (no machine-readable fare data in the feed).

## Quick start: connect an MCP client

The fastest way to use `ttc-mcp` is via `npx`, pointing a stdio-capable MCP client at the published package — no clone, build, or database setup required (the npm package ships a prebuilt libSQL file).

```json
{
  "mcpServers": {
    "ttc": {
      "command": "npx",
      "args": ["-y", "ttc-mcp"]
    }
  }
}
```

Drop that into your client's MCP config (e.g. Claude Desktop's `claude_desktop_config.json`, or an equivalent `mcpServers` block) and restart the client.

### Installing the package directly

```bash
npm install -g ttc-mcp
ttc-mcp   # runs the stdio server
```

Or without installing:

```bash
npx ttc-mcp
```

## Tools

Every tool returns `structuredContent` matching its Zod `outputSchema`, plus the same JSON serialized as text content. Inputs/outputs use normalized snake_case DTOs (never raw GTFS passthrough); ids (`stop_id`, `route_id`) are opaque numeric strings; times are absolute ISO 8601 with the `America/Toronto` offset. See [`docs/spec/tool-schemas.md`](./docs/spec/tool-schemas.md) for the full design rationale.

### Static schedule

| Tool | Purpose | Input | Output |
|---|---|---|---|
| `search_stops` | Find stops/stations by name and/or proximity to a point | `{ query?, near?: {lat, lon, radius_m?}, mode?, limit? }` (one of `query`/`near` required) | `{ stops: StopSummary[], truncated, error? }` |
| `get_stop` | Details for a single stop/station | `{ stop_id }` | `{ stop?: StopSummary & { platforms?, routes: RouteSummary[] }, error? }` |
| `get_schedule` | Next-N scheduled departures at a stop, honoring the service-day calendar | `{ stop_id, route_id?, when?, limit? }` | `{ stop?, departures: ScheduledDeparture[], truncated, hint?, error? }` |
| `list_routes` | The full route catalog, optionally filtered by mode | `{ mode? }` | `{ routes: RouteSummary[] }` |
| `get_route` | Details for a single route: directions and stops per direction | `{ route_id }` | `{ route?: RouteSummary & { directions, stops_by_direction?, truncated }, error? }` |

### Real-time

| Tool | Purpose | Input | Output |
|---|---|---|---|
| `get_arrivals` | Next arrivals at a stop — live predictions for bus/streetcar, scheduled fallback for subway or when RT is unavailable | `{ stop_id, route_id?, limit? }` | `{ stop?, arrivals: Arrival[], realtime_available, truncated, hint?, error? }` |
| `get_vehicles` | Live vehicle positions for a route (bus/streetcar only; subway returns an empty, non-error result) | `{ route_id, limit? }` | `{ route_id, vehicles: Vehicle[], realtime_available, truncated, note?, error? }` |
| `get_alerts` | Live service alerts (outages, detours, delays, planned work), filterable and subway-inclusive | `{ mode?, route_id?, stop_id?, category?, limit? }` | `{ alerts: Alert[], truncated, error? }` |

### Fares & planning

| Tool | Purpose | Input | Output |
|---|---|---|---|
| `get_fare` | The current TTC fare table plus the 2-hour transfer rule | `{ category?, fare_type? }` | `{ fares: Fare[], transfer, notes, source_url }` |
| `plan_trip` | Plan a multi-modal (bus/streetcar/subway) journey between two endpoints, with transfers | `{ from, to, when?, arrive_by?, max_transfers?, max_itineraries?, modes? }` | `{ from, to, itineraries: Itinerary[], candidates?, error? }` |

`from`/`to` each accept a `stop_id`, a place name, or `{lat, lon}`; an ambiguous name is a **success**, returning `candidates` to disambiguate rather than an error.

## Prompts

Prompt templates are thin wrappers: they tell the client which tool(s) to call and how to present the result. None of them touch the database or RT client directly.

| Prompt | Purpose | Arguments | Composes |
|---|---|---|---|
| `check_my_commute` | Next arrivals at a stop, live where available | `stop_id`, `route_id?` | `get_arrivals` |
| `service_status` | Current service alerts, optionally scoped | `mode?`, `route_id?`, `stop_id?`, `category?` | `get_alerts` |
| `nearby_stops` | Stops near a point, with platform/route details | `lat`, `lon`, `radius_m?`, `mode?` | `search_stops`, `get_stop` |
| `plan_a_trip` | Guided multi-modal trip planning, including the candidates-disambiguation loop | `from`, `to`, `when?`, `arrive_by?` | `plan_trip` |

## Resources

Resources mirror the corresponding tool's DTO exactly, for MCP clients that browse resources rather than call tools.

| Resource | MIME type | Returns |
|---|---|---|
| `ttc://fares` | `application/json` | The full TTC fare table — the `get_fare` tool's DTO |
| `ttc://stops` | `application/json` | The full stop/station catalog (`StopSummary[]`), unfiltered and uncapped |
| `ttc://routes` | `application/json` | The full route catalog (`RouteSummary[]`), unfiltered — the `list_routes` tool's DTO |

## Self-hosting

### Quick start (Docker)

```bash
docker run -p 3000:3000 ghcr.io/emilsoleymani/ttc-mcp:latest
```

Or with the provided [`docker-compose.yml`](./docker-compose.yml):

```bash
docker compose up -d
```

The image bakes a local libSQL file from TTC's live GTFS feed at build time, so it's self-contained — no external database needed. Once running, connect an MCP client to `http://localhost:3000/mcp` (Streamable HTTP), or `curl http://localhost:3000/health` for a liveness check.

### Configuration

| Var | Purpose | Default |
|---|---|---|
| `LIBSQL_URL` | Schedule DB connection: a `file:...` path (the Docker image's baked-in local file) or a `libsql://...turso.io` Turso URL | `file:./data/ttc.db` |
| `LIBSQL_AUTH_TOKEN` | Turso auth token (only needed when `LIBSQL_URL` points at Turso) | — |
| `GTFS_RT_BASE_URL` | Overridable GTFS-Realtime base URL | `https://bustime.ttc.ca/gtfsrt` |
| `RT_CACHE_TTL_SECONDS` | Coalescing cache window for decoded RT feeds | `25` |
| `CACHE_ENABLED` | Set `false` to disable RT response caching entirely | `true` |
| `PORT` | HTTP transport port | `3000` |

### Updating

The Docker image is self-contained, so picking up newer TTC schedule data means pulling a freshly-built image (the upstream `GTFS Refresh` workflow rebuilds and republishes on a weekly cadence, or trigger your own rebuild):

```bash
docker compose pull && docker compose up -d
```

If you instead point `LIBSQL_URL` at a shared Turso database, data freshness follows that database directly — no image update needed.

## Local development

```bash
git clone https://github.com/EmilSoleymani/ttc-mcp.git
cd ttc-mcp
npm ci
npm run ingest    # downloads the live TTC feed, builds ./data/ttc.db
npm run build
npm run start:http   # or: npm run start:stdio
```

For iterating on the HTTP transport with live reload:

```bash
npm run dev   # tsx watch on src/entry/http.ts, Streamable HTTP on :3000
```

Useful scripts (see [`package.json`](./package.json) for the full list):

| Script | Purpose |
|---|---|
| `npm run ingest` | Download the live TTC GTFS feed and (re)build `./data/ttc.db` |
| `npm run dev` | Streamable HTTP server with live reload (`/mcp`, `/health` on `:3000`) |
| `npm run start:stdio` / `npm run start:http` | Run the built server (stdio / Streamable HTTP) |
| `npm run build` | Type-check and emit to `dist/` |
| `npm test` | Run the test suite (Vitest) |
| `npm run typecheck` / `npm run lint` / `npm run format:check` | Static checks |
| `npm run mcp-inspector` | Launch the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to browse/call tools, prompts, and resources interactively |

To inspect the server interactively: build it (or run `npm run dev` for HTTP), then run `npm run mcp-inspector` and point it at the stdio command (`node dist/entry/stdio.js`) or the running HTTP endpoint (`http://localhost:3000/mcp`).

## License

[MIT](./LICENSE) © 2026 Emil Soleymani
