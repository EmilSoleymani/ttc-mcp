# ttc-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **Toronto Transit Commission (TTC)**. Exposes subway, streetcar, and bus schedules, live vehicle positions, real-time arrivals, and service alerts to LLM clients — plus multi-modal trip planning with transfers.

Built entirely on TTC's **official open feeds** — no API key required:

- **Static GTFS** (routes, stops, schedules) from [open.toronto.ca](https://open.toronto.ca/dataset/ttc-routes-and-schedules)
- **GTFS-Realtime** (vehicle positions, trip updates, service alerts) from `bustime.ttc.ca`

TypeScript · stdio + Streamable HTTP transports · self-hostable via Docker or Vercel.

Sibling project to [go-planning-mcp](https://github.com/EmilSoleymani/go-planning-mcp) (GO Transit / Metrolinx).

> **Status: in active development.** Tracked via a wayfinder map under [`.wayfinder/`](./.wayfinder/map.md) — most of the static-schedule surface (stops, routes, schedules) is implemented; real-time tools and `plan_trip` are landing incrementally. See the repo's open issues for exact status.

## Scope notes

- Real-time coverage (live positions & arrivals) is **bus + streetcar only** — TTC does not publish subway real-time. Subway is served from the static schedule plus service alerts.
- Fares are a flat PRESTO fare with a 2-hour transfer window (no machine-readable fare data in the feed).

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

### Building from source

```bash
git clone https://github.com/EmilSoleymani/ttc-mcp.git
cd ttc-mcp
npm ci
npm run ingest    # downloads the live TTC feed, builds ./data/ttc.db
npm run build
npm run start:http   # or: npm run start:stdio
```

## License

[MIT](./LICENSE) © 2026 Emil Soleymani
