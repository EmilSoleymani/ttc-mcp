# plan_trip PR1 — DTOs + routing query layer + endpoint resolution

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development.
> Steps use checkbox (`- [ ]`) syntax. Each task ends green on
> `npm run typecheck && npm run lint && npm run format:check && npm test`.

**Goal:** Land the foundation for `plan_trip` with no routing loop yet: the
itinerary/leg DTOs, the SQL query layer (footpaths, access-stop expansion,
boarding, riding, service-day resolution), and endpoint resolution
(stop_id/name/lat-lon → access stops, with the ambiguous→candidates contract).

**Design spec:** `docs/superpowers/specs/2026-08-04-plan-trip-design.md`.
**ADRs:** 0001 (approach), 0002 (candidates DTO + pattern key).

## Global constraints

- Node ESM: **every relative import ends in `.js`**.
- IDs are INTEGER in DB, **strings** in DTOs.
- Absolute ISO 8601 America/Toronto via `service-time.ts` helpers; reuse
  `activeServiceIds` from `schedule-repository.ts` (export it).
- Reuse `toStopSummary`, `getStopById`, `searchStopsByName`, `searchStopsNear`
  from `stops-repository.ts`.
- Access radius **250 m**, access fan-out cap **8**, walk speed **1.3 m/s**,
  `max_transfers` hard cap **3**.

---

### Task 1: Itinerary DTOs — `src/schemas/itinerary.ts`

**Files:** create `src/schemas/itinerary.ts`; test `src/schemas/itinerary.test.ts`.

- [ ] **Step 1 (red):** Assert the discriminated-union `legSchema` parses a
  transit leg and a transfer leg, rejects a transit leg missing `board`, and that
  `planTripOutputShape` accepts an ambiguous-shaped result (`from: null`,
  `candidates`, empty `itineraries`).
- [ ] **Step 2 (green):** Define, reusing `stopSummarySchema`/`modeSchema`:
  - `transitLegSchema` = `{ type:"transit", mode, route_id, route_short_name?,
    headsign, board, alight, board_time, alight_time, num_stops }`.
  - `transferLegSchema` = `{ type:"transfer", from, to, walk_seconds }`.
  - `legSchema = z.discriminatedUnion("type", [...])`.
  - `itinerarySchema = { depart_time, arrive_time, duration_seconds, transfers,
    legs: Leg[] }`.
  - `candidatesSchema = { endpoint: z.enum(["from","to"]), matches: StopSummary[] }`.
  - `planTripInputShape` = `{ from, to, when?, arrive_by?, max_transfers?
    (int 0–3), modes? (modeSchema[]), max_itineraries? (int 1–…) }` where
    `from`/`to` = `z.union([z.string(), z.object({lat,lon})])`.
  - `planTripOutputShape` = `{ from: stopSummarySchema.nullable(),
    to: stopSummarySchema.nullable(), itineraries: itinerarySchema[],
    candidates: candidatesSchema.optional(), error: toolErrorSchema.optional() }`.

---

### Task 2: Fixture enrichment — `src/gtfs/test-support.ts`

**Files:** modify `src/gtfs/test-support.ts`.

Extend `buildFixtureDb` (or add `buildRoutingFixtureDb`) so routing has something
to walk. Add, alongside the existing Union/Line-1/route-900 data:

- [ ] A **transfer pair** in the `transfers` table (e.g. a subway platform ↔ a
  nearby surface stop, `type:"street"`, a known `min_walk_seconds`).
- [ ] A **two-seat ride**: a second route whose trip lets a rider transfer from
  the first and continue — so a later ladder test can find a 1-transfer plan.
- [ ] A **branch**: two trips on one route+direction with **different
  `trip_headsign`** diverging after a shared stem (exercises the pattern key).
- [ ] A **past-midnight trip**: a `dep`/`arr` > 86400 on yesterday's service_id
  (exercises the windowed service-day time base).

Keep the existing fixture rows/ids stable so current tests stay green.

---

### Task 3: Query layer — `src/gtfs/routing/queries.ts`

**Files:** create `src/gtfs/routing/queries.ts`; test `src/gtfs/routing/queries.test.ts`.
Export `activeServiceIds` from `schedule-repository.ts` (or lift it to
`service-time.ts` / a shared module) for reuse.

- [ ] **`fetchFootpaths(client, stopIds): Promise<TransferRow[]>`** — `SELECT
  from_stop_id, to_stop_id, min_walk_seconds, type FROM transfers WHERE
  from_stop_id IN (...)`. Test: returns the seeded transfer pair; empty for an
  isolated stop.
- [ ] **`fetchBoardings(client, marked, serviceIds, modes?)`** — the VALUES-CTE
  boarding query (design §"Boarding query"). `marked` = `{stop_id, min_dep}[]`.
  Returns earliest `{stop_id, route_id, direction_id, headsign, dep, trip_id}`
  per pattern. Tests: (a) picks the earliest trip per pattern; (b) respects
  **per-stop** thresholds (a stop with a higher `min_dep` skips the too-early
  trip and returns the next); (c) the **branch** yields two rows (two headsigns);
  (d) `modes` filter excludes off-mode routes.
- [ ] **`fetchDownstream(client, tripIds)`** — the riding query; returns
  `{trip_id, stop_id, stop_sequence, arr, dep}[]` ordered. Test: downstream stops
  of a boarded trip in sequence, `arr` present.
- [ ] Keep these pure of time-base logic — callers pass `serviceIds`/`min_dep`
  already in a chosen date's dep-space.

---

### Task 4: Access-stop expansion + endpoint resolution — `src/gtfs/routing/index.ts`

**Files:** create `src/gtfs/routing/index.ts`; test `src/gtfs/routing/resolve.test.ts`.
(PR1 ships resolution only; the `planTrip` ladder call is a PR2 stub/TODO.)

- [ ] **`accessStops(client, endpoint): Promise<{ stop: StopSummary; walk_seconds }[]>`**
  - `stop_id` → the stop (walk 0) + `fetchFootpaths` neighbours (their
    `min_walk_seconds`), each resolved to a `StopSummary`.
  - `{lat,lon}` → `searchStopsNear(250)` capped at 8 nearest, walk = haversine ÷ 1.3.
  - Tests: stop_id yields itself + transfer neighbour with the seeded walk time;
    lat/lon yields nearby stops with sane walk seconds; fan-out capped at 8.
- [ ] **`resolveEndpoint(client, value): Promise<Resolved | Ambiguous | NotFound>`**
  - string that is all-digits → treat as `stop_id` (`getStopById`); else name
    (`searchStopsByName`). **> 1 name match ⇒ `Ambiguous(matches)`.** `{lat,lon}`
    → always `Resolved` (nearest), empty → `NotFound`.
  - Tests: unknown stop_id → NotFound; ambiguous name (fixture: 2 stops sharing a
    name substring) → Ambiguous with both matches; unique name → Resolved;
    lat/lon → Resolved.
- [ ] **`resolveBothEndpoints(client, from, to)`** — resolve `from` then `to`;
  first ambiguous → `{ candidates: { endpoint, matches } }`; a NotFound →
  `{ error }`; both Resolved → `{ from, to }`. Test the precedence
  (`from` ambiguity reported before `to`).

---

### Task 5: Reconcile the spec docs

**Files:** modify `docs/spec/tool-schemas.md`.

- [ ] Annotate the `ambiguous` taxonomy line: candidates for `plan_trip` are
  **top-level and success-shaped**, per ADR 0002 — not nested in `error`. Leave
  the historical wording but point readers at the ADR.

---

## Definition of done (PR1)

- `src/schemas/itinerary.ts`, `src/gtfs/routing/{queries,index}.ts` land with
  tests; fixture extended; `tool-schemas.md` annotated.
- No `plan_trip` tool registered yet (PR2 wires it) — this PR is importable
  library + schema only.
- All green: `npm run typecheck && npm run lint && npm run format:check && npm test`.
