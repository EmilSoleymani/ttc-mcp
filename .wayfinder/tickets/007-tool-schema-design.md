---
id: "007"
title: "Grilling: Tool Schema & DTO Design"
type: grilling
status: resolved
blocked_by: ["005"]
blocks: ["009"]
---

## Question

Given the tool roster (005), design the detailed input/output schemas — the TTC analog of go-planner's tool-schema spec, adopting its **conventions** while fitting TTC's data shapes. Work one question at a time.

Decisions needed:
1. **Normalized DTOs** — snake_case, never raw GTFS/GTFS-RT passthrough; Zod-backed `outputSchema` + `structuredContent` on every tool (go-planner's rule).
2. **ID model** — TTC's identifier surface: GTFS `stop_id` vs. `stop_code` (the numeric codes printed at stops / on signage), subway `station` vs. platform stops, `route_id` vs. route short name ("504", "Line 1"). Decide the opaque-string IDs the tools expose and how human names resolve to them (fuzzy match against the ingested catalog). Unify where go-planner unified (a single `stop_code`-style handle).
3. **Time & timezone** — ISO 8601 with America/Toronto clock defaults; how GTFS `HH:MM:SS` past-24h times and `calendar_dates` service exceptions surface.
4. **Error taxonomy** — in-result errors with a closed code enum; disambiguation (ambiguous stop name → candidate list) is a *success*, not an error (go-planner rule).
5. **Anti-dump** — result caps, `truncated` flags, narrow-filter hints; two-mode schedule tool if needed to avoid dumping a whole day of `stop_times`.
6. **Real-time fields** — placeholder for how RT freshness/predicted-vs-scheduled is represented in DTOs (detailed integration is ticket 008; keep the schema shape compatible).

**Deliverable:** `docs/spec/tool-schemas.md` in the repo.

## Answer

Grilled 2026-07-23. Full spec: [`../../docs/spec/tool-schemas.md`](../../docs/spec/tool-schemas.md).

- **Stop identity: `stop_id` canonical, stations aggregate.** Opaque numeric stop_id handle; passing a station id to get_schedule/get_arrivals aggregates child platforms **grouped by direction**. DTOs also carry stop_code, name, mode, is_station, accessible.
- **Route identity: `route_id` canonical** (reads as the route number for TTC); DTOs carry short/long name, mode, subway color. One identity model across the API; names resolve via fuzzy match.
- **Times: absolute ISO 8601 + America/Toronto offset** (int seconds resolved against service date → past-midnight handled). Adopted from go-planner.
- **`get_schedule`: single bounded next-N tool** (cap ~20, `truncated` + narrow hint) — no full-day dumps. Same cap/truncated/hint pattern on search_stops.
- **Adopted conventions:** snake_case Zod `outputSchema`/`structuredContent` on every tool; **closed-enum in-result errors** with `ambiguous` returning a candidate list as a *success*. TTC error codes defined: `not_found`, `ambiguous`, `no_results`, `unsupported` (e.g. subway vehicles), `invalid_argument`, `upstream_unavailable`.
- Full per-tool input/output DTOs for all 10 tools + the 3 Resources recorded in the spec. RT `Arrival`/`Vehicle` field shapes kept compatible, **finalized in ticket 008**; `plan_trip` DTO → ticket 009.
