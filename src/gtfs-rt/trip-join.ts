import type { StaticTrip } from "../gtfs/trips-repository.js";

/**
 * The trip descriptor a GTFS-RT `TripUpdate` carries (`trip.trip_id`,
 * `trip.route_id`, and — when present — an RT headsign). All three are
 * optional on the wire, so every field is nullable here.
 */
export interface RtTripRef {
  tripId?: string | null | undefined;
  routeId?: string | null | undefined;
  headsign?: string | null | undefined;
}

/**
 * The identity fields `get_arrivals` needs to attribute a predicted
 * `stop_time_update` to a human-readable route/direction — the subset of the
 * `Arrival` DTO (docs/spec/tool-schemas.md #6) that comes from the trip, not
 * the prediction time. `matched` records whether the static enrichment was
 * found (`true`) or the RT-only fallback was used (`false`), so the caller
 * can decide whether a scheduled `delay_seconds` is resolvable.
 */
export interface ArrivalIdentity {
  route_id: string;
  route_short_name?: string;
  headsign: string;
  direction_id: number;
  matched: boolean;
}

function presenceOf(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolves the route/direction identity for one RT prediction, joining to the
 * static trip when its `trip_id` matched and falling back to the RT trip
 * descriptor when it didn't.
 *
 * **Never-drop guarantee (docs/spec/realtime-integration.md #4):** an
 * unmatched `trip_id` never costs an arrival. When `staticTrip` is
 * `undefined`, the RT-provided `route_id` (+ RT headsign, if any) is surfaced
 * directly with `matched:false` — the prediction is still fully usable. The
 * only case that yields `undefined` is a descriptor with **no usable route at
 * all** (missing/blank `route_id` *and* no static match), the RT analogue of
 * a deadheading vehicle — there is simply nothing to attribute the arrival
 * to. A failed `trip_id` join alone is never that case.
 */
export function resolveArrivalIdentity(
  rt: RtTripRef,
  staticTrip: StaticTrip | undefined,
): ArrivalIdentity | undefined {
  const rtRouteId = presenceOf(rt.routeId);
  const rtHeadsign = presenceOf(rt.headsign);

  if (staticTrip) {
    return {
      route_id: String(staticTrip.route_id),
      ...(staticTrip.route_short_name !== undefined
        ? { route_short_name: staticTrip.route_short_name }
        : {}),
      // Prefer the static headsign; fall back to the RT-provided one, then to
      // "" (never drop on a blank headsign — the project's stated posture,
      // mirrors schedule-repository's toScheduledDeparture).
      headsign: staticTrip.headsign ?? rtHeadsign ?? "",
      direction_id: staticTrip.direction_id ?? 0,
      matched: true,
    };
  }

  // Unmatched trip_id → RT-only fallback. Keep the arrival as long as the RT
  // descriptor names a route; direction_id is unknown from RT alone (→ 0).
  if (rtRouteId === undefined) return undefined;
  return {
    route_id: rtRouteId,
    headsign: rtHeadsign ?? "",
    direction_id: 0,
    matched: false,
  };
}
