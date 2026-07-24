---
id: "001"
title: "Research: TTC Feed & API Inventory"
type: research
status: resolved
blocked_by: []
blocks: ["005", "006", "008"]
---

## Question

Produce the TTC analog of go-planner's Metrolinx API inventory: a complete, empirical inventory of the **official** TTC data sources everything else in the map hangs on. Answer, with evidence (actual fetched responses, not just docs):

**Static GTFS ("TTC Routes and Schedules", open.toronto.ca / CKAN):**
1. Exact current download URL(s) for the GTFS ZIP (and the CKAN dataset/resource API endpoint that resolves to the latest ZIP). Is there a "merged GTFS" (all modes) vs. per-mode split?
2. Which GTFS files are present in the ZIP — critically: `transfers.txt`? `shapes.txt`? `fare_attributes.txt` / `fare_rules.txt`? `frequencies.txt`? `calendar.txt` + `calendar_dates.txt`? Approximate ZIP + uncompressed size, row counts of the big tables (`stop_times`).
3. Refresh cadence in practice, and how to detect a new version (last-modified header, version field, CKAN `last_modified`).
4. **Licensing** — the open.toronto.ca license terms and any GTFS Access-and-Use agreement; is redistribution / derivative real-time use permitted for an open-source MCP?

**GTFS-Realtime (`bustime.ttc.ca/gtfsrt/`):**
5. Exact endpoint URLs for each of the three feeds: VehiclePositions, TripUpdates, Alerts.
6. **Wire format** — standard GTFS-RT protobuf, or is JSON available? (go-planner deliberately avoided a protobuf dep by getting GTFS-RT as JSON — confirm whether TTC forces protobuf, which is an architecture delta.)
7. Do **TripUpdates carry real arrival/departure predictions** (predicted times), or only schedule-adherence deltas? This determines whether the official feed covers the "next arrivals" use case without the unofficial prediction API.
8. Coverage: do all three modes (subway, streetcar, bus) appear in each feed? Any known gaps (e.g., subway vehicle positions)?
9. Auth, rate limits, terms of use for the RT endpoints (any documented, or fair-use only).

**Deliverable:** a findings report at `.wayfinder/research/001-ttc-feed-inventory.md`, plus a short "open items / risks" list (anything unconfirmed that a downstream decision should treat as an assumption). Flag any place where the official feeds fall short of go-planner's capability set.

## Answer

Resolved by subagent 2026-07-23 (all findings verified live, not doc claims). Full report: [`../research/001-ttc-feed-inventory.md`](../research/001-ttc-feed-inventory.md).

- **GTFS-RT is protobuf-only.** `bustime.ttc.ca/gtfsrt/{vehicles,trips,alerts}` all return `application/x-google-protobuf`; `?format=json` is ignored. Standard GTFS-RT v2.0, no auth, no documented rate limits. **→ protobuf dependency is forced** (confirms the delta in tickets 004 & 008).
- **TripUpdates carry REAL predictions** — absolute epoch `arrival.time`/`departure.time` (23k+ values, zero `delay`-only entries). No unofficial prediction API needed for surface routes.
- **`transfers.txt` does NOT exist** in either ZIP. Also missing: `fare_attributes`/`fare_rules`, `frequencies`. Present: `calendar` + `calendar_dates`, `shapes`. **→ invalidates the "transfers.txt if present" assumption in tickets 006 & 009; forces a proximity/interchange-graph transfer model. → no GTFS fare data at all (ticket 005 fares).**
- **Two static datasets, both single merged all-modes feeds:** `ttc-routes-and-schedules` (opendata_ttc_schedules.zip, **35 MB**, 8 files, ~6-week refresh, freshest) vs. `merged-gtfs-ttc-routes-and-schedules` (completegtfs.zip, **81 MB**, 11 files incl. `feed_info`/`pathways`/`levels`, quarterly). **→ ticket 006 must pick one; these sizes feed the "derived .db vs Vercel budget" measurement.**
- **Biggest gap: NO subway real-time.** VehiclePositions & TripUpdates are **bus + streetcar only** (Lines 1/2/4 absent). Subway appears only in Alerts + static schedule. **→ shapes tickets 005 & 008 (RT arrivals/positions are surface-only) and 009 (no RT-aware subway routing).**
- **Open items / risks:** license discrepancy — portal states Open Government Licence – Toronto (redistribution/commercial/derivative OK, attribution required) but CKAN metadata says `notspecified` / `isopen:false`; RT terms & rate limits undocumented (treat as fair-use, be polite).
