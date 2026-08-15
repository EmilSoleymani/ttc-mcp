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
4. **Decide direction**, using only patterns clearing the coverage
   `threshold`: the best must beat the best candidate of a *different
   direction* by a `margin`. Failing that, the trip is still on shared trunk
   track where both directions score alike → decline, and the arrival surfaces
   with route and time only.
5. **Decide the branch**, among the winning direction's candidates: the best
   must beat the best candidate carrying a *different headsign* by the same
   `margin`. Failing that, only the terminal is unknown — the direction is
   not — so the direction's **canonical headsign** (the most-tripped one among
   the candidates) is used instead.
6. On a confident match, take `direction_id` + headsign and compute
   `delay_seconds = predicted − nearest scheduled departure of that route at
   that stop` (`scheduledDelaySeconds`).

Thresholds (`src/gtfs-rt/pattern-match.ts`): coverage ≥ `0.6`, margin `0.2`.
These are deliberately conservative — the cost of a wrong direction (telling a
rider the bus goes the opposite way) is far higher than the cost of saying
nothing, so ambiguous trunk trips stay unmatched.

### Why direction and branch are decided separately

They fail independently, and collapsing them loses far more than it protects.
Scoring a single `direction + headsign` identity means two *branches of the
same direction* count as disagreeing rivals and trip the margin — so a trip
whose direction was never in doubt gets declined because the schedule offers it
two plausible terminals. Measured on a live feed, **90% of the trips that fail
the branch test have every candidate agreeing on direction** (502 of 557); only
9.9% genuinely split across directions. Deciding direction first lifted
recovery from 68.6% to 97.0%.

### Why there's no "towards &lt;terminal&gt;" fallback

An earlier revision named the last stop of the RT `stopTimeUpdate[]` list as
the trip's destination. That list is not the trip's remaining journey — it ends
wherever the feed's prediction horizon does. Measured live, the last stop is a
real static terminus for only **4.5% of matched** and **14.8% of unmatched**
trips; 85% of the time "towards X" named a mid-route stop, and in 70 cases the
stop the rider was standing at. There is no wording that fixes that, so the
fallback was removed: an undecidable trip reports its route and time and
asserts nothing else.

### Why not just borrow the RT headsign?

TTC rarely populates it, and its `directionId` is a constant `0` — so it can't
disambiguate direction even when a headsign is present. The pattern match
recovers a *real* `direction_id` and is authoritative when confident; the RT
headsign is only a weak fallback when no pattern matches at all.

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
| `ambiguous` | trips still on shared trunk track, where direction is undecidable — they surface with route + time only |

**How to read it:** `recovery_pct` is the headline — the "measured majority of
live arrivals" the acceptance criterion asks for. `ambiguous` is the honest
residue: those arrivals still surface, they just assert no direction, headsign,
or delay.

## Measured result

Run 2026-08-15, weekday afternoon, against the live `bustime.ttc.ca` feed with
a schedule DB ingested from the 2026-07-26 → 2026-09-05 GTFS:

```json
{
  "rt_trip_updates": 1828,
  "trips_with_route": 1828,
  "trips_with_crosswalked_stops": 1812,
  "recovered": 1757,
  "recovery_pct": 97.0,
  "ambiguous": 55
}
```

**97.0% of live trips recover a direction**, and every remaining arrival still
surfaces with its route and time. For comparison, the first revision of this
match — which scored `direction + headsign` as one identity — measured 68.6%
on the same feed; separating the two decisions accounts for the difference.

The logic is also verified deterministically in
`src/gtfs-rt/pattern-match.test.ts` and `src/gtfs-rt/arrivals-repository.test.ts`
against the fixture network (branch disambiguation, direction-from-order,
trunk-ambiguity decline, canonical-headsign fallback, and `delay_seconds`).

## Acceptance criteria (from #33)

- [x] `get_arrivals` surfaces `direction_id` + `trip_headsign` for pattern-matched live arrivals (97.0% of live trips — measured above).
- [x] `get_arrivals` populates `delay_seconds` (predicted − scheduled at the stop) for matched arrivals; omitted when unmatched.
- [x] Confidence threshold (coverage `0.6`, margin `0.2`) below which `direction_id`, `headsign` and `delay_seconds` are all omitted rather than guessed.
- [x] Measured headsign-recovery harness + methodology documented (`measure-headsign-recovery`), and run against the live feed.
- [x] `SKIPPED`/`NO_DATA` stop-time updates are skipped when recovering identity.

## Deliberately left for a follow-up

- **Mixed-mode interchange stations queried by station id** still route to the
  scheduled fallback via `pickMode`'s subway priority (the #11 follow-up note);
  surfacing per-platform live predictions for a mixed-mode station id is
  independent of the pattern match here and is left untouched.
