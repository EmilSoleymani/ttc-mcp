---
id: "005"
title: "Grilling: MCP Tool & Primitive Roster"
type: grilling
status: resolved
blocked_by: ["001"]
blocks: ["007", "008", "009"]
---

## Question

Using the feed inventory from ticket 001, decide the **TTC-native** tool / resource / prompt roster — what the MCP exposes. Per the user: name things whatever makes sense for TTC, do **not** mechanically copy go-planner's names or structure. Work one question at a time.

Decisions needed:
1. **The tool list.** Candidate surface (rename/merge/drop as fits TTC): list/search routes (subway lines, streetcars, buses); search stops/stations by name or proximity; scheduled service at a stop (from ingested GTFS); live vehicle positions (filtered); live next-arrivals / trip updates at a stop; service alerts (filterable by mode/route/stop/category incl. elevator-escalator). Which make the v1 cut? **CONFIRMED (ticket 001): TripUpdates carry real epoch-time predictions, so live next-arrivals is viable — BUT vehicles + trip-updates are BUS + STREETCAR ONLY (no subway real-time). Subway live tools would return nothing; decide how the roster handles that asymmetry** (e.g. arrivals tool honestly reports "schedule only" for subway stops, falls back to the ingested GTFS timetable).
2. **Fares.** **CONFIRMED (ticket 001): the GTFS ZIP has NO `fare_attributes`/`fare_rules` — there is zero machine-readable fare data.** TTC fare is effectively a constant ($3.20 PRESTO + 2-hour transfer window). So a `get_fares` tool could only return a hardcoded/static value. Decide: skip it, expose it as a static Resource, or fold the fact into a prompt. No live/queryable fare source exists.
3. **Primitive split** — which of these are **Tools** (live/parameterized queries) vs. **Resources** (slow-changing static data like the route/stop catalog) vs. **Prompts** (v1 templates, e.g. "next vehicle at my stop", "is my line disrupted"). Note go-planner shipped static data as BOTH a Resource and a mirror Tool because many clients ignore Resources — decide whether to repeat that.
4. **Filtering discipline** — GTFS-RT feeds are full-dataset snapshots (context-hostile). Confirm the go-planner rule holds: RT is exposed only through server-side-filtered tools, never raw dumps.
5. **`plan_trip` placeholder** — reserve its name and one-line contract here, but its full design is ticket 009 (deferred). Just ensure the roster leaves a clean seam for it.

**Deliverable:** the roster decision recorded in this ticket's Answer; the detailed schemas are ticket 007. Graduates the "Resources & Prompts roster" fog line on the map.

## Answer

Grilled 2026-07-23. TTC-native naming (not a copy of go-planner's). Detailed schemas → ticket 007.

### Tools (10)

**Catalog & schedule (from ingested GTFS):**
1. `search_stops(query, near?, mode?)` — find stops/stations by name or lat-lng proximity
2. `get_stop(stop)` — stop/station details: routes served, location, accessibility, mode
3. `list_routes(mode?)` — subway lines · streetcars · buses
4. `get_route(route)` — directions, stops served
5. `get_schedule(stop, route?, when?)` — scheduled departures at a stop (anti-dump discipline per ticket 007)

**Real-time (GTFS-RT, protobuf; bus + streetcar):**
6. `get_arrivals(stop, route?)` — **unified**: live predicted next arrivals for bus/streetcar; for **subway stops it transparently returns the next SCHEDULED departures** from the ingested GTFS, tagged `realtime: false` / `source: "scheduled"`. One tool for any stop, honest labeling. (Detail → ticket 008.)
7. `get_vehicles(route)` — live vehicle positions, server-side filtered by route; for subway routes returns an **empty result + reason** (no subway RT).
8. `get_alerts(mode?, route?, stop?, category?)` — service alerts incl. elevator/escalator; **subway-inclusive** (Alerts feed covers subway).

**Fares:**
9. `get_fare(...)` — returns the hand-maintained TTC fare table (adult/senior/youth PRESTO + cash, 2-hour transfer rule, passes).

**Trip planning:**
10. `plan_trip(...)` — **reserved name only**; full design deferred to ticket 009. Roster leaves a clean seam.

### Resources

- `ttc://stops` — full stop/station catalog (~9k rows; static, opt-in read)
- `ttc://routes` — full route catalog
- `ttc://fares` — same fare table as `get_fare`
- Catalog data is exposed as **both Resources and mirror Tools** (belt-and-suspenders — covers Resource-ignoring clients). Fares likewise (tool + resource).

### Prompts

- **v1 ships:** `check_my_commute` (wraps `get_arrivals`), `service_status` (wraps `get_alerts`), `nearby_stops` (wraps `search_stops(near)` + `get_stop`).
- **Reserved, ships with ticket 009:** `plan_a_trip` (wraps `plan_trip`) — cannot exist before the tool it composes.

### Cross-cutting rules (adopted from go-planner, per stack-baseline)

- **GTFS-RT exposed ONLY through server-side-filtered tools — never raw full-dataset dumps.**
- Every tool gets a Zod `outputSchema` + `structuredContent` (schema detail → ticket 007).

### Hand-offs
- **Ticket 007** (schemas): DTOs, ID model, the `realtime`/`source` field shape on `get_arrivals`, anti-dump on `get_schedule`.
- **Ticket 008** (RT): implements the `get_arrivals` unified/fallback behavior and `get_vehicles` subway-empty behavior.
- **Ticket 009** (plan_trip): builds `plan_trip` + the `plan_a_trip` prompt.
