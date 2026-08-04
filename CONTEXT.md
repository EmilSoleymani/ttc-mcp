# Context — ttc-mcp Ubiquitous Language

A glossary for the TTC MCP domain. Terms here are domain concepts, not
implementation. Routing-specific terms were pinned during the `plan_trip`
design (issue #12, `docs/spec/plan-trip.md`).

## Stops & identity

- **Stop** — a boardable location (a bus/streetcar pole or a subway platform).
  Its canonical handle is the opaque `stop_id`.
- **Station** — a parent stop (`location_type = 1`) that groups child
  **platforms**. A station id aggregates its platforms.
- **Mode** — `subway | streetcar | bus`. Derived from the routes serving a
  stop, never stored on the stop itself.

## Trip planning (`plan_trip`)

- **Itinerary** — one complete journey from origin to destination: an ordered
  list of legs with an overall depart time, arrive time, duration, and
  transfer count.
- **Leg** — one segment of an itinerary. Either:
  - **Transit leg** — riding one vehicle from a board stop to an alight stop
    on a single pattern.
  - **Transfer leg** — a walk (footpath) between two stops; never appears
    back-to-back with another transfer.
- **Pattern** — a distinct service variant of a route: the practical grouping
  of trips that serve the same places in the same order. Approximated by
  `(route_id, direction_id, headsign)` because TTC's feed has no pattern table
  and its `shape_id` is GPS-noisy.
- **Footpath / Transfer** — a walkable connection between two nearby stops,
  with a walk time. Three kinds: **station** (shared parent, in-station),
  **pathway** (measured subway in-station walk), **street** (proximity ≤250 m).
  These are the synthesized stand-in for GTFS's absent `transfers.txt`.
- **Access stops** — the small set of stops an origin expands to: the origin
  stop itself plus its nearby footpath neighbors. A lat/lon origin snaps to
  nearby stops.
- **Egress** — the final walk from the last alighting stop to the destination;
  its walk time counts toward the itinerary's arrival.
- **Candidate** — when an endpoint (a place name) is ambiguous, the planner
  returns the matching stops as `candidates` instead of routing. This is a
  *success*, not an error — the caller disambiguates and retries.
- **depart-after** — plan leaving at/after a given time (the native query).
- **arrive_by** — plan arriving by a given time (latest departure). Emulated
  via the forward engine, not computed exactly.
- **Service day** — the GTFS calendar day a trip belongs to, which can run
  past midnight (a `dep` past 24:00 belongs to the prior service day).
