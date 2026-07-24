---
id: "005"
title: "Grilling: MCP Tool & Primitive Roster"
type: grilling
status: open
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
