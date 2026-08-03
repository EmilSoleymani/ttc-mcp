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

**How to read it:** overlap **< 100 % is expected and fine** — the static feed refreshes ~every 6 weeks (`docs/spec/gtfs-ingestion.md`) while the RT backend can reference a newer board period, and the RT feed is bus + streetcar only while static includes subway. The join is trustworthy for `get_arrivals` as long as **`unmatched_updates_unrecoverable` is 0**, i.e. every unmatched arrival still has an RT `route_id` to fall back to. (TTC TripUpdates always carry `trip.route_id`, so this is expected to hold; the script flags it loudly if it ever doesn't.)

## Decision: join strategy + never-drop fallback

Implemented as two small, tested units that `get_arrivals` (#11) composes:

1. **Static lookup** — `src/gtfs/trips-repository.ts`
   - `parseRtTripId(rtTripId)` → the integer join key (or `null`).
   - `getStaticTripById(client, id)` → `StaticTrip { trip_id, route_id, route_short_name?, headsign?, direction_id? }` (joined to `routes` for the short name), or `undefined`.

2. **Identity resolution + fallback** — `src/gtfs-rt/trip-join.ts`
   - `resolveArrivalIdentity(rtTripRef, staticTrip)` → the `Arrival` identity subset `{ route_id, route_short_name?, headsign, direction_id, matched }`.
   - **Matched** (`trip_id` joined): enrich from the static trip; `matched: true`. A scheduled `delay_seconds` is resolvable in this branch.
   - **Unmatched** (`trip_id` didn't join — stale, non-numeric, or absent): surface the RT-provided `route_id` + RT `headsign` directly, `direction_id: 0`, `matched: false`. **The prediction is never dropped.** `delay_seconds` is omitted (no scheduled time to diff against).
   - **Only** returns `undefined` when there is no usable route at all (no static match _and_ no RT `route_id`) — the RT analogue of a deadheading vehicle, nothing to attribute the arrival to. A failed `trip_id` join **alone** is never this case.

This is verified in `src/gtfs-rt/trip-join.test.ts` (matched enrichment, unmatched RT-only fallback, non-numeric id, missing-`trip_id`-but-has-`route_id`, and the deadhead-analogue drop) and `src/gtfs/trips-repository.test.ts` (parse equivalence, lookup, batch existence).

## Findings captured for `get_arrivals` (#11)

- Fetch predictions via `RtClient.getTripUpdates()`; for each `stop_time_update` at the target stop, predicted `time` = `arrival.time` (fallback `departure.time`), epoch → `toTorontoIso`.
- Resolve route/direction identity with `getStaticTripById(client, parseRtTripId(update.trip.trip_id))` → `resolveArrivalIdentity(update.trip, staticTrip)`. Splice its fields onto the `Arrival` DTO; add `time`, `realtime: true`, `source: "predicted"`.
- Set `delay_seconds` only when `matched` **and** the scheduled time for that trip/stop is resolvable from the ingested GTFS; omit otherwise.
- `realtime_available` on the envelope reflects whether **any** RT prediction was found for the stop; a subway stop — or any stop with no live trips in the window — falls back to the scheduled path (`realtime:false`, `source:"scheduled"`), so the tool always answers.
- **Never drop an arrival because its `trip_id` didn't join** — the fallback above is the guarantee.
