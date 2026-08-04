import type { Client, InValue } from "@libsql/client";

import type { Mode } from "../../schemas/stop.js";
import {
  asText,
  modeForRouteType,
  presence,
  routeTypeForMode,
} from "../stops-repository.js";
import type { TransferType } from "../transfers.js";

// The SQL layer for plan_trip's ladder
// (docs/superpowers/specs/2026-08-04-plan-trip-design.md §"Algorithm"). Every
// function here is time-base-agnostic: callers pass thresholds and service ids
// already resolved into a single service date's dep-space.

export interface Footpath {
  from_stop_id: number;
  to_stop_id: number;
  min_walk_seconds: number;
  type: TransferType;
}

/** Outgoing footpaths (transfers) from any of `stopIds`. */
export async function fetchFootpaths(
  client: Client,
  stopIds: readonly number[],
): Promise<Footpath[]> {
  if (stopIds.length === 0) return [];
  const placeholders = stopIds.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT from_stop_id, to_stop_id, min_walk_seconds, type
          FROM transfers
          WHERE from_stop_id IN (${placeholders})`,
    args: [...stopIds],
  });
  return result.rows.map((row) => ({
    from_stop_id: Number(row.from_stop_id),
    to_stop_id: Number(row.to_stop_id),
    min_walk_seconds: Number(row.min_walk_seconds),
    type: asText(row.type) as TransferType,
  }));
}

/** A stop reached so far, with the earliest departure (in the target service
 * date's dep-space) the rider could board there. */
export interface MarkedStop {
  stop_id: number;
  min_dep: number;
}

/** The earliest boardable trip of a pattern at a marked stop. */
export interface Boarding {
  stop_id: number;
  route_id: number;
  direction_id: number | null;
  headsign: string;
  dep: number;
  trip_id: number;
}

/**
 * The earliest trip per pattern `(route_id, direction_id, headsign)` boardable
 * at each marked stop, honouring each stop's own `min_dep` threshold (via the
 * VALUES CTE join — never a shared global min) and, optionally, a `modes`
 * filter. Bare-column `trip_id` alongside `MIN(dep)` returns the matching trip
 * (SQLite min/max special case). See ADR 0002 for the pattern key.
 */
export async function fetchBoardings(
  client: Client,
  marked: readonly MarkedStop[],
  serviceIds: readonly number[],
  modes?: readonly Mode[],
): Promise<Boarding[]> {
  if (marked.length === 0 || serviceIds.length === 0) return [];

  const markedValues = marked.map(() => "(?, ?)").join(", ");
  const markedArgs: InValue[] = marked.flatMap((m) => [m.stop_id, m.min_dep]);
  const servicePlaceholders = serviceIds.map(() => "?").join(", ");

  const modeFilter =
    modes && modes.length > 0
      ? `JOIN routes r ON r.route_id = t.route_id
         AND r.route_type IN (${modes.map(() => "?").join(", ")})`
      : "";
  const modeArgs: InValue[] =
    modes && modes.length > 0 ? modes.map((m) => routeTypeForMode(m)) : [];

  const result = await client.execute({
    sql: `WITH marked(stop_id, min_dep) AS (VALUES ${markedValues})
          SELECT st.stop_id AS stop_id, t.route_id AS route_id,
                 t.direction_id AS direction_id, t.trip_headsign AS headsign,
                 MIN(st.dep) AS dep, st.trip_id AS trip_id
          FROM stop_times st
          JOIN marked m ON m.stop_id = st.stop_id AND st.dep >= m.min_dep
          JOIN trips t ON t.trip_id = st.trip_id
          ${modeFilter}
          WHERE t.service_id IN (${servicePlaceholders})
            AND st.dep IS NOT NULL
          GROUP BY st.stop_id, t.route_id, t.direction_id, t.trip_headsign`,
    args: [...markedArgs, ...modeArgs, ...serviceIds],
  });

  return result.rows.map((row) => ({
    stop_id: Number(row.stop_id),
    route_id: Number(row.route_id),
    direction_id: row.direction_id === null ? null : Number(row.direction_id),
    // GTFS may leave trip_headsign blank; a pattern is still valid.
    headsign: row.headsign === null ? "" : asText(row.headsign),
    dep: Number(row.dep),
    trip_id: Number(row.trip_id),
  }));
}

/** A stop on a boarded trip (used to relax downstream arrival labels). */
export interface DownstreamStop {
  trip_id: number;
  stop_id: number;
  stop_sequence: number;
  arr: number | null;
  dep: number | null;
}

/** All stop_times for the boarded trips, ordered by trip then sequence. The
 * caller keeps only stops downstream of each trip's boarding sequence. */
export async function fetchDownstream(
  client: Client,
  tripIds: readonly number[],
): Promise<DownstreamStop[]> {
  if (tripIds.length === 0) return [];
  const placeholders = tripIds.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT trip_id, stop_id, stop_sequence, arr, dep
          FROM stop_times
          WHERE trip_id IN (${placeholders})
          ORDER BY trip_id, stop_sequence`,
    args: [...tripIds],
  });
  return result.rows.map((row) => ({
    trip_id: Number(row.trip_id),
    stop_id: Number(row.stop_id),
    stop_sequence: Number(row.stop_sequence),
    arr: row.arr === null ? null : Number(row.arr),
    dep: row.dep === null ? null : Number(row.dep),
  }));
}

/** Route metadata for a transit leg: the short name (if present) and the mode
 * derived from route_type. */
export interface RouteMeta {
  route_short_name?: string;
  mode: Mode;
}

export async function fetchRouteMeta(
  client: Client,
  routeIds: readonly number[],
): Promise<Map<number, RouteMeta>> {
  const meta = new Map<number, RouteMeta>();
  if (routeIds.length === 0) return meta;
  const placeholders = routeIds.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT route_id, route_short_name, route_type
          FROM routes
          WHERE route_id IN (${placeholders})`,
    args: [...routeIds],
  });
  for (const row of result.rows) {
    const shortName = presence(
      row.route_short_name === null ? null : asText(row.route_short_name),
    );
    meta.set(Number(row.route_id), {
      ...(shortName !== undefined ? { route_short_name: shortName } : {}),
      mode: modeForRouteType(Number(row.route_type)),
    });
  }
  return meta;
}
