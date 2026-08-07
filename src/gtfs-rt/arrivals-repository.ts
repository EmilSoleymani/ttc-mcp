import type { Client } from "@libsql/client";
// See rt-client.ts for why the runtime enum value goes through the default
// export while the types come from the named `transit_realtime` import.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime } from "gtfs-realtime-bindings";
import type Long from "long";

import { scheduledDelaySeconds } from "../gtfs/schedule-repository.js";
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

/** stop_name for each of the given static stop ids — the terminal-stop text
 * the unmatched fallback surfaces as "towards <name>". */
async function stopNames(
  client: Client,
  stopIds: number[],
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const unique = [...new Set(stopIds)];
  if (unique.length === 0) return map;
  const placeholders = unique.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT stop_id, stop_name FROM stops WHERE stop_id IN (${placeholders})`,
    args: unique,
  });
  for (const row of result.rows) {
    if (row.stop_name !== null && row.stop_name !== undefined) {
      map.set(Number(row.stop_id), asText(row.stop_name));
    }
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

  // Prefetch the terminal-stop names the unmatched fallback needs.
  const terminalIds = window
    .map((p) => {
      const seq = staticSeqOf(p);
      return seq.length > 0 ? seq[seq.length - 1] : undefined;
    })
    .filter((id): id is number => id !== undefined);
  const names = await stopNames(client, terminalIds);

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
      const seq = staticSeqOf(pred);
      const match = matchPattern(
        seq,
        await patternsFor(identity.route_id),
        pred.queriedStopId,
      );
      if (match) {
        identity = {
          ...identity,
          headsign: match.headsign,
          direction_id: match.direction_id,
          matched: true,
        };
      } else if (identity.headsign === "") {
        // No confident pattern and no RT headsign → name the trip's terminal.
        const terminal = seq.length > 0 ? seq[seq.length - 1] : undefined;
        const terminalName =
          terminal !== undefined ? names.get(terminal) : undefined;
        if (terminalName !== undefined) {
          identity = { ...identity, headsign: `towards ${terminalName}` };
        }
      }
    }

    // delay_seconds rides along only with a confident identity (#33): a
    // scheduled time is trustworthy to diff against once we know which
    // route/direction the live trip is.
    let delaySeconds: number | undefined;
    if (identity.matched) {
      const routeNum = Number(identity.route_id);
      if (Number.isInteger(routeNum)) {
        delaySeconds = await scheduledDelaySeconds(
          client,
          pred.queriedStopId,
          routeNum,
          pred.epoch,
        );
      }
    }

    resolved.push({
      arrival: {
        route_id: identity.route_id,
        ...(identity.route_short_name !== undefined
          ? { route_short_name: identity.route_short_name }
          : {}),
        headsign: identity.headsign,
        direction_id: identity.direction_id,
        time: toTorontoIso(pred.epoch),
        realtime: true,
        source: "predicted" as const,
        ...(delaySeconds !== undefined ? { delay_seconds: delaySeconds } : {}),
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
