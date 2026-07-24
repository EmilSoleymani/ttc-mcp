---
id: "007"
title: "Grilling: Tool Schema & DTO Design"
type: grilling
status: open
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
