import type { Client } from "@libsql/client";
// See rt-client.ts for why the runtime enum value goes through the default
// export while the types come from the named `transit_realtime` import.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime } from "gtfs-realtime-bindings";
import type Long from "long";

import { scheduleAdherence } from "../gtfs/schedule-repository.js";
import { asText } from "../gtfs/stops-repository.js";
import { getStaticTripById, parseRtTripId } from "../gtfs/trips-repository.js";
import type { Arrival } from "../schemas/arrival.js";
import {
  loadRoutePatterns,
  matchPattern,
  type RoutePattern,
} from "./pattern-match.js";
import { resolveArrivalIdentity } from "./trip-join.js";
import { toTorontoIso } from "./vehicles-repository.js";

const { transit_realtime: GtfsRt } = GtfsRealtimeBindings;
const ScheduleRelationship =
  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship;

function epochToNumber(
  value: number | Long | null | undefined,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "number" ? value : value.toNumber();
}

/**
 * A stop-time update we can't take at face value as a prediction: `SKIPPED`
 * (the vehicle won't serve this stop — a residual time must not surface as an
 * arrival) or `NO_DATA` (no real-time information for this stop). TTC currently
 * only emits `SCHEDULED`, so this is latent today, but honouring it keeps a
 * future `SKIPPED`/`NO_DATA` from being reported as a live arrival (#33).
 */
function isNonPredictive(
  stu: transit_realtime.TripUpdate.IStopTimeUpdate,
): boolean {
  return (
    stu.scheduleRelationship === ScheduleRelationship.SKIPPED ||
    stu.scheduleRelationship === ScheduleRelationship.NO_DATA
  );
}

/** RT stop ids (as strings, matching the wire) for the given static stop ids. */
async function crosswalkForStops(
  client: Client,
  stopIds: number[],
): Promise<Map<string, number>> {
  const placeholders = stopIds.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT rt_stop_id, stop_id FROM rt_stop_crosswalk WHERE stop_id IN (${placeholders})`,
    args: stopIds,
  });
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(String(Number(row.rt_stop_id)), Number(row.stop_id));
  }
  return map;
}

/** Static stop_id for each of the given RT stop ids (the reverse-direction
 * crosswalk, keyed on the wire `stopId`). Used to resolve a whole live trip's
 * ordered stop list — not just the queried stop — for pattern matching. */
async function crosswalkForRtStops(
  client: Client,
  rtStopIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (rtStopIds.length === 0) return map;
  const numeric = rtStopIds.map(Number).filter((n) => Number.isFinite(n));
  if (numeric.length === 0) return map;
  const placeholders = numeric.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT rt_stop_id, stop_id FROM rt_stop_crosswalk WHERE rt_stop_id IN (${placeholders})`,
    args: numeric,
  });
  for (const row of result.rows) {
    map.set(String(Number(row.rt_stop_id)), Number(row.stop_id));
  }
  return map;
}

/** route_id -> route_short_name for the given ids (route_id == route_short_name for TTC). */
async function routeShortNames(
  client: Client,
  routeIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (routeIds.length === 0) return map;
  const placeholders = routeIds.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT route_id, route_short_name FROM routes WHERE route_id IN (${placeholders})`,
    args: routeIds.map(Number),
  });
  for (const row of result.rows) {
    if (row.route_short_name !== null && row.route_short_name !== undefined) {
      map.set(String(Number(row.route_id)), asText(row.route_short_name));
    }
  }
  return map;
}

interface Prediction {
  trip: transit_realtime.ITripDescriptor;
  epoch: number;
  queriedStopId: number;
  /** The live trip's ordered stop list on the wire (for pattern shape). */
  rtStopIds: string[];
}

/**
 * Predicted arrivals at `targetStopIds` (the queried stop, or a station's
 * platform ids) from a decoded TripUpdates feed. Predictions are located by
 * crosswalking each RT stopId to a static stop_id (#11); each live trip's
 * ordered stop list is then matched back to a static service pattern (#33) to
 * recover the `direction_id`/`headsign` the RT feed omits and to resolve a
 * scheduled time for `delay_seconds`. Unmatched trips fall back to
 * terminal-stop text ("towards …") with `delay_seconds` omitted. Sorted by
 * time, capped at `limit`.
 */
export async function predictedArrivals(
  client: Client,
  tripUpdates: transit_realtime.ITripUpdate[],
  targetStopIds: number[],
  routeId: string | undefined,
  now: Date,
  limit: number,
): Promise<{ arrivals: Arrival[]; truncated: boolean }> {
  if (targetStopIds.length === 0) return { arrivals: [], truncated: false };
  const targetCrosswalk = await crosswalkForStops(client, targetStopIds);
  if (targetCrosswalk.size === 0) return { arrivals: [], truncated: false };

  const nowMs = now.getTime();
  const predictions: Prediction[] = [];
  for (const update of tripUpdates) {
    const trip = update.trip;
    if (!trip) continue;
    if (routeId !== undefined && trip.routeId !== routeId) continue;
    const stopUpdates = update.stopTimeUpdate ?? [];
    const rtStopIds = stopUpdates
      .map((stu) => stu.stopId)
      .filter((id): id is string => id !== null && id !== undefined);
    for (const stu of stopUpdates) {
      if (stu.stopId === null || stu.stopId === undefined) continue;
      const queriedStopId = targetCrosswalk.get(stu.stopId);
      if (queriedStopId === undefined) continue;
      if (isNonPredictive(stu)) continue;
      const epoch =
        epochToNumber(stu.arrival?.time) ?? epochToNumber(stu.departure?.time);
      if (epoch === undefined || epoch * 1000 < nowMs) continue;
      predictions.push({ trip, epoch, queriedStopId, rtStopIds });
    }
  }

  predictions.sort((a, b) => a.epoch - b.epoch);
  const window = predictions.slice(0, limit + 1);

  // One crosswalk over every stop the windowed trips visit, so each live
  // trip's full ordered stop list resolves to static ids for pattern matching.
  const allRtStopIds = [...new Set(window.flatMap((p) => p.rtStopIds))];
  const fullCrosswalk = await crosswalkForRtStops(client, allRtStopIds);
  const staticSeqOf = (p: Prediction): number[] =>
    p.rtStopIds
      .map((id) => fullCrosswalk.get(id))
      .filter((id): id is number => id !== undefined);

  const patternCache = new Map<string, RoutePattern[]>();
  const patternsFor = async (route: string): Promise<RoutePattern[]> => {
    const cached = patternCache.get(route);
    if (cached) return cached;
    const loaded = await loadRoutePatterns(client, route);
    patternCache.set(route, loaded);
    return loaded;
  };

  const resolved: { arrival: Arrival }[] = [];
  for (const pred of window) {
    const key = parseRtTripId(pred.trip.tripId);
    const staticTrip =
      key === null ? undefined : await getStaticTripById(client, key);
    const base = resolveArrivalIdentity(pred.trip, staticTrip);
    if (!base) continue; // no usable route at all — the single never-drop drop

    let identity = base;
    if (!identity.matched) {
      const match = matchPattern(
        staticSeqOf(pred),
        await patternsFor(identity.route_id),
        pred.queriedStopId,
      );
      // No match means the trip is on shared trunk track where even its
      // direction is undecided. It keeps whatever headsign RT gave (usually
      // none) and asserts no direction — the arrival still surfaces with its
      // route and time, which is the never-drop posture (#33).
      if (match) {
        identity = {
          ...identity,
          headsign: match.headsign,
          direction_id: match.direction_id,
          matched: true,
        };
      }
    }

    // Schedule adherence rides along only with a confident identity (#33):
    // there is no scheduled trip to diff against until we know which route and
    // direction the live trip is. Identity failing is reported ahead of any
    // headway question — that question never got asked.
    const unavailable: NonNullable<Arrival["unavailable"]> = [];
    let delaySeconds: number | undefined;
    if (!identity.matched) {
      unavailable.push(
        { field: "direction_id", reason: "unmatched_trip" },
        { field: "delay_seconds", reason: "unmatched_trip" },
      );
    } else {
      const routeNum = Number(identity.route_id);
      const adherence = Number.isInteger(routeNum)
        ? await scheduleAdherence(
            client,
            pred.queriedStopId,
            routeNum,
            identity.direction_id,
            pred.epoch,
          )
        : ({ kind: "unavailable", reason: "no_scheduled_service" } as const);
      if (adherence.kind === "measured") {
        delaySeconds = adherence.delaySeconds;
      } else {
        unavailable.push({
          field: "delay_seconds",
          reason: adherence.reason,
        });
      }
    }

    resolved.push({
      arrival: {
        route_id: identity.route_id,
        ...(identity.route_short_name !== undefined
          ? { route_short_name: identity.route_short_name }
          : {}),
        headsign: identity.headsign,
        // Only a confident identity carries a direction: an unmatched trip's
        // `direction_id` is the RT feed's hardcoded 0, not a measurement, so it
        // is omitted rather than asserted (#33).
        ...(identity.matched ? { direction_id: identity.direction_id } : {}),
        time: toTorontoIso(pred.epoch),
        realtime: true,
        source: "predicted" as const,
        ...(delaySeconds !== undefined ? { delay_seconds: delaySeconds } : {}),
        ...(unavailable.length > 0 ? { unavailable } : {}),
      },
    });
  }

  // Fill any route_short_name the identity didn't already carry (the common
  // case: an unmatched trip whose route is real but only named via `routes`).
  const missingShortNames = [
    ...new Set(
      resolved
        .filter((r) => r.arrival.route_short_name === undefined)
        .map((r) => r.arrival.route_id),
    ),
  ];
  const shortNames = await routeShortNames(client, missingShortNames);
  const arrivals: Arrival[] = resolved.map((r) => {
    if (r.arrival.route_short_name !== undefined) return r.arrival;
    const shortName = shortNames.get(r.arrival.route_id);
    return shortName !== undefined
      ? { ...r.arrival, route_short_name: shortName }
      : r.arrival;
  });

  return {
    arrivals: arrivals.slice(0, limit),
    truncated: arrivals.length > limit,
  };
}
