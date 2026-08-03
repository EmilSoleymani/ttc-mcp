# GTFS-RT `trip_id` ↔ static `trips` join — validation & decision

**Issue:** #9 (research spike). **Consumed by:** #11 `get_arrivals`.
**Spec:** [`docs/spec/realtime-integration.md`](../spec/realtime-integration.md) §4 (Static ↔ RT join) flagged this as the "**required first-implementation validation**."

## The risk

`get_arrivals` reads predicted times from the GTFS-RT **TripUpdates** feed, then needs the human-readable `route_short_name` / `headsign` / `direction_id` that a bare `stop_time_update` doesn't carry. Those come from the ingested static `trips` table, joined on `trip_id`. The spec flagged that GTFS-RT `trip_id` is only _assumed_ to match the static feed's `trip_id` — TTC's realtime feed comes from a Clever Devices backend, the static feed from the City's GTFS export, and the two are not contractually guaranteed to agree.

## The decisive structural finding (offline, from the code)

The join key is **not a raw string compare** — it is fixed by how ingestion stored the static side:

- `src/gtfs/schema.ts`: `trips.trip_id` is declared `INTEGER PRIMARY KEY`.
- `src/gtfs/ingest.ts`: the `trips` row mapper stores `toInt(r.trip_id)` (`src/gtfs/transform.ts`).

So the static `trip_id` is a **parsed integer**, not the original string. GTFS-RT delivers `trip.trip_id` as a **wire string**. The join is therefore well-defined **only if the RT side is parsed the same way**. That is exactly what `parseRtTripId` does — it delegates to the same `toInt`:

```
static PK   =  toInt(static_trip_id_string)      // at ingest
RT join key =  toInt(rt_trip_id_string)          // parseRtTripId, at query time
```

Because both sides pass through the identical parse, any numeric `trip_id` collapses to the same integer on both sides (e.g. `"007"` and `7` both become `7`), and a **non-numeric** RT `trip_id` yields `null` — which is treated as "no match, use the fallback," never a crash. This is the match key: **`toInt(trip_id)`, applied identically on both sides.**

> Corollary worth noting for future ingest changes: if TTC ever emits non-numeric static `trip_id`s, `toInt` would map them to `NULL`, and an `INTEGER PRIMARY KEY` column silently substitutes a rowid — the static ids would be wrong _before_ any RT join. Today TTC's `trip_id`s are numeric, so this holds; the freshness/smoke tooling would surface a format change.

## Measuring the live overlap

The structural analysis says the join _can_ work; the acceptance criterion asks for the measured **overlap** on a live sample. That requires the live TripUpdates feed, which is **only reachable from a host with network egress to `bustime.ttc.ca`** (it is blocked by policy in the CI sandbox this was authored in — same constraint the smoke suite documents). The measurement is packaged as a reproducible script so the number can be captured wherever the feed is reachable:

```bash
npm run ingest            # build ./data/ttc.db (or point LIBSQL_URL at Turso)
npm run validate-rt-join  # samples the live feed, prints a report + JSON
```

`src/entry/validate-rt-join.ts` fetches one live TripUpdates sample (`RtClient.getTripUpdates()`), reconciles every distinct RT `trip_id` against the ingested `trips` table (`staticTripIdsExisting`), and reports:

| Metric | Meaning |
|---|---|
| `distinct_rt_trip_ids` | distinct `trip_id`s in the live sample |
| `numeric_trip_ids` / `non_numeric_trip_ids` | how many parse to an integer |
| `matched_trip_ids` / `overlap_pct` | how many join to static, and the % |
| `unmatched_updates` | RT updates whose `trip_id` did **not** join |
| `unmatched_updates_recovered` | of those, how many the fallback still surfaces (has a `route_id`) |
| `unmatched_updates_unrecoverable` | the only red flag — an update with no route to attribute at all |

**How to read it:** the go/no-go signal is **`unmatched_updates_unrecoverable` = 0** — every arrival still has an RT `route_id` to attribute it to. TTC TripUpdates always carry `trip.route_id`, so this holds; the script flags it loudly if it ever doesn't.

## Measured result (2026-08-03, live feed) — overlap is 0% *by design*

Running `npm run validate-rt-join` against the live `bustime.ttc.ca` TripUpdates feed with a current DB (`data/ttc.db`, calendar `20260726`–`20260905`):

| Metric | Value |
|---|---|
| Static trips ingested | 133,682 |
| Distinct RT `trip_id`s (numeric / non-numeric) | 1,694 (1,694 / 0) |
| **Matched in static / overlap %** | **0 / 0%** |
| Unmatched updates recovered / unrecoverable | 1,694 / **0** ✅ |

The overlap is **0%, and this is structural, not a stale-DB artifact or a bug** — confirmed against the raw wire:

- TTC TripUpdates carry `scheduleRelationship: NEW` with `directionId` pinned to `0` and **no `startDate`/`startTime`**. These are **synthetic, dynamically-assigned trips** the Clever Devices backend invents — they were never meant to reference a static `trip_id`. The RT `trip_id`s are negative signed-32-bit hashes (`"-262058982"`); static `trip_id`s are positive sequential ints (`50,655,365`–`50,790,571`). Disjoint namespaces.
- The VehiclePositions feed uses *different* positive `trip_id`s (`96171080`, `SCHEDULED`) — those also match static at **0%**. Neither RT feed shares the static trip namespace.

**Consequence for `get_arrivals`:** the `matched: true` branch of `resolveArrivalIdentity` — the one that enriches from a joined static trip — **effectively never fires against live TTC data.** The route path is the *primary* path, not a fallback. What still aligns and carries the tool:

- RT `route_id` → static `route_short_name`: **99%** (165/166; only `"600"` is orphan).
- RT `stop_id` → static `stop_id`: **~59%** (4,941/8,331) — partial; a crosswalk (#11 / #33) is needed to close the rest.
- Predicted times + `stopSequence` are always present; `vehicle.id` on ~99% of updates.

The never-drop guarantee (`unmatched_updates_unrecoverable: 0`) holds perfectly, so `get_arrivals` still answers for every arrival — but on route identity, not trip identity. Direction/headsign recovery is deferred to a stop-pattern match (#33); a namespace-matched data source is evaluated in #34.

> The earlier expectation in this doc — "overlap < 100% is expected and fine (board-period drift)" — was wrong in *degree*: it's not near-100% with some drift, it's **0% by construction**. The structural safety analysis above (never-drop, no crash) stands; the *semantic* trip_id join does not.

## Decision: join strategy + never-drop fallback

Implemented as two small, tested units that `get_arrivals` (#11) composes:

1. **Static lookup** — `src/gtfs/trips-repository.ts`
   - `parseRtTripId(rtTripId)` → the integer join key (or `null`).
   - `getStaticTripById(client, id)` → `StaticTrip { trip_id, route_id, route_short_name?, headsign?, direction_id? }` (joined to `routes` for the short name), or `undefined`.

2. **Identity resolution + fallback** — `src/gtfs-rt/trip-join.ts`
   - `resolveArrivalIdentity(rtTripRef, staticTrip)` → the `Arrival` identity subset `{ route_id, route_short_name?, headsign, direction_id, matched }`.
   - **Unmatched — the live norm** (`trip_id` didn't join, which per the measured result is ~100% of live arrivals because they are `NEW` synthetic trips): surface the RT-provided `route_id` + RT `headsign` directly, `direction_id: 0`, `matched: false`. **The prediction is never dropped.** `delay_seconds` is omitted (no scheduled time to diff against).
   - **Matched** (`trip_id` joined): enrich from the static trip; `matched: true`; a scheduled `delay_seconds` is resolvable. Retained as a correctness-preserving branch — it fires if TTC's RT backend ever emits static-referencing `trip_id`s — but against today's feed it is effectively unused.
   - **Only** returns `undefined` when there is no usable route at all (no static match _and_ no RT `route_id`) — the RT analogue of a deadheading vehicle, nothing to attribute the arrival to. A failed `trip_id` join **alone** is never this case.

This is verified in `src/gtfs-rt/trip-join.test.ts` (matched enrichment, unmatched RT-only fallback, non-numeric id, missing-`trip_id`-but-has-`route_id`, and the deadhead-analogue drop) and `src/gtfs/trips-repository.test.ts` (parse equivalence, lookup, batch existence).

## Findings captured for `get_arrivals` (#11)

- **Key `get_arrivals` off `(route_short_name, stop_id)`, not `trip_id`.** The `trip_id` join is measured at 0% against live data (synthetic `NEW` trips), so treat `matched: false` as the expected path.
- Fetch predictions via `RtClient.getTripUpdates()`; for each `stop_time_update` at the target stop, predicted `time` = `arrival.time` (fallback `departure.time`), epoch → `toTorontoIso`.
- Resolve the route label from the RT `route_id` → static `route_short_name` (99% coverage); locate arrivals at the queried stop by RT `stop_id` == static `stop_id` (~59% today — the gap needs a stop crosswalk, #11 / #33). Still call `resolveArrivalIdentity` so the `matched` branch is honoured if a static `trip_id` ever does join.
- **Direction/headsign is not reliably recoverable from `trip_id`** (RT `direction_id` is uselessly `0`). Ship route + times first; recover direction/headsign via a stop-sequence pattern match once stops are crosswalked (#33).
- Set `delay_seconds` only when `matched` **and** the scheduled time for that trip/stop is resolvable from the ingested GTFS; omit otherwise (i.e. omit for essentially all live arrivals today).
- `realtime_available` on the envelope reflects whether **any** RT prediction was found for the stop; a subway stop — or any stop with no live trips in the window — falls back to the scheduled path (`realtime:false`, `source:"scheduled"`), so the tool always answers.
- **Never drop an arrival because its `trip_id` didn't join** — the fallback above is the guarantee.
