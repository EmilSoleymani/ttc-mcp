import type { Client } from "@libsql/client";
import type { transit_realtime } from "gtfs-realtime-bindings";
import type Long from "long";

import { asText } from "../gtfs/stops-repository.js";
import { getStaticTripById, parseRtTripId } from "../gtfs/trips-repository.js";
import type { Arrival } from "../schemas/arrival.js";
import { resolveArrivalIdentity } from "./trip-join.js";
import { toTorontoIso } from "./vehicles-repository.js";

function epochToNumber(
  value: number | Long | null | undefined,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "number" ? value : value.toNumber();
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

/**
 * Predicted arrivals at `targetStopIds` (the queried stop, or a station's
 * platform ids) from a decoded TripUpdates feed. Predictions are located by
 * crosswalking each RT stopId to a static stop_id; identity is resolved with
 * the #9 join units (trip_id is 0% against live TTC, so this is the RT-only
 * fallback path in practice). Sorted by time, capped at `limit`.
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
  const crosswalk = await crosswalkForStops(client, targetStopIds);
  if (crosswalk.size === 0) return { arrivals: [], truncated: false };

  const nowMs = now.getTime();
  const predictions: {
    trip: transit_realtime.ITripDescriptor;
    epoch: number;
  }[] = [];
  for (const update of tripUpdates) {
    const trip = update.trip;
    if (!trip) continue;
    if (routeId !== undefined && trip.routeId !== routeId) continue;
    for (const stu of update.stopTimeUpdate ?? []) {
      if (stu.stopId === null || stu.stopId === undefined) continue;
      if (!crosswalk.has(stu.stopId)) continue;
      const epoch =
        epochToNumber(stu.arrival?.time) ?? epochToNumber(stu.departure?.time);
      if (epoch === undefined || epoch * 1000 < nowMs) continue;
      predictions.push({ trip, epoch });
    }
  }

  predictions.sort((a, b) => a.epoch - b.epoch);
  const window = predictions.slice(0, limit + 1);

  const identities: {
    identity: NonNullable<ReturnType<typeof resolveArrivalIdentity>>;
    epoch: number;
  }[] = [];
  for (const { trip, epoch } of window) {
    const key = parseRtTripId(trip.tripId);
    const staticTrip =
      key === null ? undefined : await getStaticTripById(client, key);
    const identity = resolveArrivalIdentity(trip, staticTrip);
    if (identity) identities.push({ identity, epoch });
  }

  const shortNames = await routeShortNames(client, [
    ...new Set(identities.map((i) => i.identity.route_id)),
  ]);

  const arrivals: Arrival[] = identities.map(({ identity, epoch }) => {
    const shortName =
      identity.route_short_name ?? shortNames.get(identity.route_id);
    return {
      route_id: identity.route_id,
      ...(shortName !== undefined ? { route_short_name: shortName } : {}),
      headsign: identity.headsign,
      direction_id: identity.direction_id,
      time: toTorontoIso(epoch),
      realtime: true,
      source: "predicted" as const,
    };
  });

  return {
    arrivals: arrivals.slice(0, limit),
    truncated: arrivals.length > limit,
  };
}
