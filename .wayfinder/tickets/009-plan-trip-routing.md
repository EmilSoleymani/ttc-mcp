---
id: "009"
title: "Grilling: plan_trip — Multi-modal Transfer Routing"
type: grilling
status: open
blocked_by: ["005", "006", "007", "008"]
blocks: []
---

## Question

**The deferred capstone** — resolve LAST, once the roster, ingestion, schemas, and RT integration are settled. Design a `plan_trip`-style tool that plans a journey **across bus, streetcar, and subway with transfers**. Per the user this was the hardest problem on go-planner (see its ADR-0003 multi-hub transfer-composition ladder); do not tackle it until everything it depends on is resolved. Work one question at a time.

Decisions needed:
1. **Routing approach — the core "how".** Choose between:
   - a **real routing engine** (OpenTripPlanner, Motis, Valhalla-transit, or a JS raptor/CSA lib) fed the ingested GTFS (+ optionally GTFS-RT for realtime routing), vs.
   - **hand-composed schedule-walking** over the ingested GTFS query layer, adapting go-planner's transfer-composition ladder (ADR-0003) to a single-agency multi-modal network with GTFS `transfers.txt` / geographic proximity for interchange.
   Weigh: infra weight on Vercel Hobby + Docker, cold-start/latency, correctness, maintenance, and whether it can reuse ticket 006's substrate.
2. **Transfer model** — **CONFIRMED (ticket 001): `transfers.txt` does NOT exist.** So interchanges must come from stop proximity and/or (if ticket 006 chose the merged feed) `pathways`/`levels` for subway stations. Decide the transfer-generation strategy, walk-time estimate, and max-transfers policy without a `transfers.txt` crutch.
3. **Realtime awareness** — does v1 plan on the static schedule only, or fold in GTFS-RT trip updates? **Note (ticket 001): RT covers bus + streetcar only — there is NO subway real-time — so any RT-aware routing is inherently partial across a multi-modal trip.** (Likely static-first, surface-RT-aware later.)
4. **Tool contract** — inputs (from/to as names→resolved stops, date/time, arrive-by vs depart-after), output DTO (legs with mode/route/board/alight/times/transfers), disambiguation behavior — consistent with ticket 007's conventions.
5. **Scope guard** — confirm what's explicitly *not* in v1 (e.g. multi-agency GO+TTC routing → that's the future backend effort, out of scope here).

**Deliverable:** an ADR + `docs/spec/plan-trip.md` in the repo. Resolving this reaches the map's destination.

## Answer
