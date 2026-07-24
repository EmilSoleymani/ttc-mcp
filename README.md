# ttc-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **Toronto Transit Commission (TTC)**. Exposes subway, streetcar, and bus schedules, live vehicle positions, real-time arrivals, and service alerts to LLM clients — plus multi-modal trip planning with transfers.

Built entirely on TTC's **official open feeds** — no API key required:

- **Static GTFS** (routes, stops, schedules) from [open.toronto.ca](https://open.toronto.ca/dataset/ttc-routes-and-schedules)
- **GTFS-Realtime** (vehicle positions, trip updates, service alerts) from `bustime.ttc.ca`

TypeScript · stdio + Streamable HTTP transports · self-hostable via Docker or Vercel.

Sibling project to [go-planning-mcp](https://github.com/EmilSoleymani/go-planning-mcp) (GO Transit / Metrolinx).

> **Status: in design.** This repo is currently being planned via a wayfinder map under [`.wayfinder/`](./.wayfinder/map.md) — spec and research first, implementation to follow. No server code yet.

## Scope notes

- Real-time coverage (live positions & arrivals) is **bus + streetcar only** — TTC does not publish subway real-time. Subway is served from the static schedule plus service alerts.
- Fares are a flat PRESTO fare with a 2-hour transfer window (no machine-readable fare data in the feed).

## License

[MIT](./LICENSE) © 2026 Emil Soleymani
