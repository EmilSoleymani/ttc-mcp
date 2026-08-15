# ADR 0003 — `delay_seconds` is gated on headway, not on the delay

**Status:** accepted (issue #33 design, 2026-08-15)

## Context

`get_arrivals` promises a `delay_seconds` per `docs/spec/tool-schemas.md` #6,
defined in `docs/spec/realtime-integration.md` as _"predicted − scheduled when
the scheduled time **for that trip/stop** is resolvable"_. That definition is
conditioned on knowing which scheduled trip a live prediction belongs to.

TTC's feed does not let us know that, twice over:

- **No delay is published.** Measured against the live feed on 2026-08-15:
  `TripUpdate.delay`, `StopTimeUpdate.arrival.delay`, `.departure.delay` and
  `.uncertainty` were sent on **0 of 1,840** trip updates / 26,469 stop-time
  updates. (Beware: `gtfs-realtime-bindings` puts protobuf field *defaults* on
  the message prototype, so `u.delay != null` reads `true` on every trip. Only
  an own-property check reflects the wire.)
- **No trip identity.** TTC's TripUpdates are synthetic — `scheduleRelationship:
  NEW`, no joinable `trip_id`, no `startDate`/`startTime` (see
  `docs/research/rt-trip-id-join.md`). #33 recovers *direction* positionally by
  stop-sequence pattern matching, but that identifies a **pattern**, not one of
  the day's trips on it.

So the scheduled counterpart has to be found by proximity: the nearest scheduled
departure of that route and direction at that stop. That is only trustworthy
when scheduled trips are far enough apart to tell apart. On a 5-minute headway
they are not — a bus 10 minutes late is indistinguishable from the next bus 2
minutes early, and nearest-matching silently reports the latter.

## Decision

`delay_seconds` is emitted only where a scheduled trip is **identifiable**:

1. the pattern match resolved the trip's direction, **and**
2. the local scheduled headway at that stop, route and direction, sampled ±30
   minutes around the prediction, is **greater than 10 minutes**, **and**
3. something scheduled falls within the existing 2-hour match window.

Otherwise it is omitted, and the arrival carries a per-arrival
`unavailable: [{ field, reason }]` entry naming why
(`unmatched_trip | frequent_service | no_scheduled_service`).

**The gate is on the headway, not on the delay.** This is the part that will
look wrong to a future reader, so: a gate on the *measurement* cannot work,
because the measurement is manufactured by the very function being gated. The
nearest-match deviation is bounded by ±headway/2 by construction, so it always
looks small and plausible. Measured on the live feed, a `|delay| < headway/3`
gate still admitted **59.4%** of the arrivals on frequent service — precisely
the ones where the number means nothing. Only something not derived from the
answer can gate the answer.

10 minutes is TTC's own Frequent Service Network standard and is the number
`CONTEXT.md` already pins for **frequent service**; using it keeps code and
glossary from drifting apart.

## Consequences

- **The measure saturates at ±5 minutes near the gate.** At a 10-minute headway,
  nearest-matching can only ever express ±headway/2. This is a documented limit
  of positional matching, not a defect to fix downstream. Tightening the
  constant trades coverage for a higher ceiling and is a one-line change.
- **Coverage is a minority of live arrivals.** Sampled across 250 stops:
  33.1% measured, 66.6% withheld as `frequent_service`, 0.4% as
  `unmatched_trip`. That is the honest size of what TTC's feed supports, not a
  regression.
- **Absence is now attributed per arrival, not per response.** 38.0% of
  multi-route stops mix frequent and infrequent service in the same response —
  e.g. stop 85 (Bathurst St), where route 160 (~30 min) reports a delay and
  route 7 (~10 min) cannot. A response-level `hint` could not have said that
  without enumerating routes back to the caller, so `hint` stays what it was:
  advice about changing the query.

## Considered and rejected

- **Report a bounded number anyway, with a caveat in the docs.** Rejected for
  inconsistency: #33 omits a `direction_id` we are 80% confident of, so emitting
  a delay we know is unidentifiable cannot be defended in the same breath.
- **Sequence fit** — score the trip's whole predicted stop list against each
  candidate scheduled trip rather than matching one stop. It narrows the
  ambiguity but does not remove it: on a regular headway a trip shifted by
  exactly one headway maps onto its neighbour. Real machinery, and it would
  still need this gate underneath it.
- **Track `vehicle.id` across polls.** `vehicle.id` is present on 1,821/1,840
  (99%) of trip updates, so following a vehicle from a terminal would yield true
  trip identity and therefore true schedule adherence. Rejected because
  per-request statelessness is a hard constraint for this server — it is a
  cached-fetch-per-request design, and this would need a persistent store, a
  poller, and cold-start behaviour. Recorded here as the door we chose not to
  open; the 99% coverage means it stays open.
- **Report headway adherence instead** on frequent service — the measure that
  actually describes those routes, and computable statelessly from a single
  poll. Deferred to its own issue rather than bolted on here; it deserves its
  own acceptance criteria and measurement.
