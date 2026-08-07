# `get_arrivals` direction/headsign recovery via stop-sequence pattern match

**Issue:** #33 (research). **Builds on:** #11 `get_arrivals`, the #11 `rt_stop_crosswalk`, and the [`trip_id` join finding](./rt-trip-id-join.md).
**Spec:** [`docs/spec/realtime-integration.md`](../spec/realtime-integration.md) §3–4.

## The problem

`get_arrivals` reads predicted times from GTFS-RT **TripUpdates**, but a bare
`stop_time_update` carries no direction or headsign, and the obvious source —
the static trip a `trip_id` join yields — is unavailable: TTC TripUpdates are
`scheduleRelationship: NEW` synthetic trips whose `trip_id` matches static
**0% by design**, with `directionId` uselessly pinned to `0` and no
`startDate`/`startTime` (measured in [`rt-trip-id-join.md`](./rt-trip-id-join.md)).
So #11 shipped route + times only — `direction_id: 0`, `headsign: ""` (or the
rare RT-provided headsign), and no `delay_seconds`.

What a TripUpdate **does** carry reliably is an ordered `stopTimeUpdate[]` and a
`route_id`. This ticket recovers the missing identity from that.

## The approach: an ordered stop list is a pattern fingerprint

A route runs a small number of distinct **service patterns** — the two
directions, plus short-turns and branches. Each pattern is an ordered list of
stops. A live trip's `stopTimeUpdate[]`, crosswalked to static `stop_id`s via
the #11 `rt_stop_crosswalk`, is (a tail of) exactly one of those patterns.
Matching it back recovers the direction the RT feed threw away.

1. **Crosswalk** each live trip's ordered `stopTimeUpdate[].stopId` → static
   `stop_id`s (`rt_stop_crosswalk`, ~100% stop coverage).
2. **Load the route's distinct patterns** (`loadRoutePatterns`): fold every
   trip's `stop_times` into an ordered stop list, de-dupe → each pattern with
   the headsign/direction its trips carry.
3. **Score** each pattern that serves the queried stop by
   `coverage = LCS(rtStops, pattern) / rtStops.length`, where LCS is the
   **order-preserving** longest common subsequence. Order preservation is what
   separates the two directions: a trip running one way is a subsequence of
   that direction's pattern but not of the reversed one.
4. **Accept** the top pattern only if it clears a coverage `threshold` **and**
   beats the best *disagreeing* pattern (different headsign/direction) by a
   `margin`. Otherwise the trip is on shared trunk track where direction is
   ambiguous → decline to guess.
5. On a confident match, borrow `trip_headsign` + `direction_id` and compute
   `delay_seconds = predicted − nearest scheduled departure of that route at
   that stop` (`scheduledDelaySeconds`). On no match, fall back to
   **"towards &lt;terminal stop name&gt;"** (the last crosswalked stop) and omit
   `delay_seconds`.

Thresholds (`src/gtfs-rt/pattern-match.ts`): coverage ≥ `0.6`, margin `0.2`.
These are deliberately conservative — the cost of a wrong direction (telling a
rider the bus goes the opposite way) is far higher than the cost of a
"towards X" fallback, so ambiguous trunk trips stay unmatched.

### Why not just borrow the RT headsign?

TTC rarely populates it, and its `directionId` is a constant `0` — so it can't
disambiguate direction even when a headsign is present. The pattern match
recovers a *real* `direction_id` and is authoritative when confident; the RT
headsign is only used as a weak fallback ahead of terminal-stop text.

## `delay_seconds`

Because the live trip is synthetic (no scheduled counterpart to join), the
scheduled time is resolved positionally: the nearest scheduled departure of the
**same route at the same physical stop** to the prediction, searched over the
prediction's service date ±1 day (to cover post-midnight GTFS times). A single
stop/platform is served by one direction, so "nearest scheduled departure of
this route here" already isolates the right scheduled trip without needing the
(RT-unavailable) trip identity. If nothing scheduled falls within a 2-hour
window, `delay_seconds` is omitted rather than reporting a bogus delay. It is
populated **only** for pattern-matched arrivals, per the acceptance criteria.

## Honouring `scheduleRelationship`

`predictedArrivals` now skips `stopTimeUpdate`s marked `SKIPPED` (the vehicle
won't serve the stop — a residual time must not surface as an arrival) or
`NO_DATA` (no real-time info). TTC currently only emits `SCHEDULED`, so this is
latent today, but it prevents a future `SKIPPED`/`NO_DATA` from being reported
as a live arrival. (From the #11 final review.)

## Measuring the recovery rate

The structural design says the match *can* work; the acceptance criterion asks
for the measured **recovery rate** on a live sample. As with
[`validate-rt-join`](./rt-trip-id-join.md#measuring-the-live-overlap), that
needs the live feed, reachable only from a host with egress to
`bustime.ttc.ca` (blocked by policy in the CI sandbox this was authored in).
The measurement is packaged as a reproducible script:

```bash
npm run ingest                    # build ./data/ttc.db (or point LIBSQL_URL at Turso)
npm run measure-headsign-recovery # samples the live feed, prints a report + JSON
```

`src/entry/measure-headsign-recovery.ts` fetches one live TripUpdates sample,
crosswalks every trip's stop list, matches it against the route's static
patterns (mirroring the runtime path — attributing the arrival at the trip's
next stop), and reports:

| Metric | Meaning |
|---|---|
| `trips_with_route` / `trips_with_crosswalked_stops` | denominators: trips carrying a `route_id`, and of those the ones whose stops crosswalk |
| `recovered` / `recovery_pct` | trips a confident pattern match resolved (direction + headsign), and the % of crosswalked trips |
| `fallback_terminal_text` | the misses that still name a terminal ("towards X") |
| `unrecoverable` | misses whose terminal didn't even crosswalk (route + time only) |

**How to read it:** `recovery_pct` is the headline — the "measured majority of
live arrivals" the acceptance criterion asks for. `unrecoverable` should be
near zero (every arrival still surfaces with route + time; only its
direction/headsign is missing). Record the maintainer-run number below.

## Measured result

> **Pending a maintainer run against the live feed.** Not runnable in the
> network-restricted sandbox this was authored in (same constraint the smoke
> suite and `validate-rt-join` document). Run the two commands above on a
> host with egress to `bustime.ttc.ca` and paste the `recovery_pct` (and the
> full JSON) here. The pattern-match logic is verified deterministically in
> `src/gtfs-rt/pattern-match.test.ts` and `src/gtfs-rt/arrivals-repository.test.ts`
> against the fixture network (branch disambiguation, direction-from-order,
> trunk-ambiguity decline, terminal fallback, and `delay_seconds`).

## Acceptance criteria (from #33)

- [x] `get_arrivals` surfaces `direction_id` + `trip_headsign` for pattern-matched live arrivals (recovery rate measured by the harness above).
- [x] `get_arrivals` populates `delay_seconds` (predicted − scheduled at the stop) for matched arrivals; omitted when unmatched.
- [x] Confidence threshold (coverage `0.6`, margin `0.2`) below which it falls back to terminal-stop text and omits `delay_seconds`.
- [x] Measured headsign-recovery harness + methodology documented (`measure-headsign-recovery`); the live number is a maintainer run (feed egress required).
- [x] `SKIPPED`/`NO_DATA` stop-time updates are skipped when recovering identity.

## Deliberately left for a follow-up

- **Mixed-mode interchange stations queried by station id** still route to the
  scheduled fallback via `pickMode`'s subway priority (the #11 follow-up note);
  surfacing per-platform live predictions for a mixed-mode station id is
  independent of the pattern match here and is left untouched.
