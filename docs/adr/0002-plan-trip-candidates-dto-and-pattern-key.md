# ADR 0002 — plan_trip: top-level candidates DTO, and the (route, direction, headsign) pattern key

**Status:** accepted (issue #12 design, 2026-08-04)

## Context

Implementing `plan_trip` (ADR 0001, `docs/spec/plan-trip.md`) surfaced two
decisions that are hard to reverse (they shape the public tool contract and the
core query) and that contradict, or aren't answered by, the existing specs.

### 1. Where do ambiguous-endpoint `candidates` live?

Two accepted spec docs disagree:

- `docs/spec/tool-schemas.md` ("Error taxonomy") returns candidates **inside the
  error object**: `{ error: { code: "ambiguous", message, candidates } }`.
- `docs/spec/plan-trip.md` (the later, tool-specific ticket 009) puts
  `candidates?` at the **top level** of the output and calls the ambiguous case
  **success-shaped** (`itineraries` empty, no error).

Additionally, `plan_trip` has **two** endpoints (`from`, `to`); neither spec
says how a caller learns *which* one is ambiguous. And the `candidates` field on
`toolErrorSchema` was never actually implemented — no prior tool marked anything
`ambiguous` — so `plan_trip` is the first consumer and sets the precedent.

### 2. What is a "route" for RAPTOR's earliest-trip pruning?

The ladder prunes to the earliest trip *per pattern* per marked stop. TTC's feed
has no pattern table. Candidate keys, measured on the ingested data:

- `(route_id, direction_id, shape_id)` — closest to a true geometric pattern, but
  `shape_id` is GPS-noisy: **41 distinct shapes for one Line 2 direction** (all
  one headsign). Over-splits, exploding the boarded-trip set.
- `(route_id, direction_id)` — one trip per direction, smallest fan-out, but
  **320 of 450 route-directions branch** (>1 shape); the single earliest trip
  silently drops branch/short-turn destinations → false "no route".
- `(route_id, direction_id, trip_headsign)` — the rider-facing branch label.
  Subway collapses to 1 group; buses split into their handful of real branches
  (e.g. route 334 dir 1 → 8 headsigns).

## Decision

**1. Top-level structured candidates, success-shaped.** `plan_trip` returns
`candidates?: { endpoint: "from" | "to", matches: StopSummary[] }` at the top
level with empty `itineraries` and **no** `error`. Endpoints resolve `from`
first, then `to`; the first ambiguous one populates `candidates`. The `error`
object is reserved for genuine failures (`not_found` for an unknown `stop_id`;
`no_results` — also success-shaped, empty + note — when endpoints resolve but
nothing is reachable). `tool-schemas.md` is annotated to point at this ADR;
`toolErrorSchema` is left as `{ code, message }` (candidates never belonged on
it).

**2. Pattern key = `(route_id, direction_id, trip_headsign)`.** The boarding
query groups on this and takes `MIN(dep)` as the earliest trip per pattern.

## Consequences

- **Candidates are machine-readable per endpoint** — the `plan_a_trip` prompt and
  any client can drive the disambiguation loop from the structured `endpoint`
  field instead of parsing a message. The two-endpoint case the taxonomy never
  considered is handled.
- **The specs are reconciled** in favour of the later, tool-specific ticket 009;
  a future reader who finds the taxonomy's "candidates-inside-error" wording is
  routed here.
- **Branch coverage without shape noise.** Headsign keeps subway pruning at one
  trip while preserving genuine bus branches. **Residual risk:** a subway
  short-turn that shares a headsign with the full-line trip could truncate
  downstream reach in a round — accepted as within ADR 0001's stated
  "lower optimality than a true RAPTOR" envelope, and revisitable if it proves
  to matter.
- If TTC ever ships a real pattern/`transfers.txt` or clean shapes, the pattern
  key can be swapped in `queries.ts` without touching the tool contract.
