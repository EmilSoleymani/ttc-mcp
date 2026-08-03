import type { Client, ResultSet } from "@libsql/client";

import type {
  RouteDetail,
  RouteDirection,
  RouteDirectionStops,
} from "../schemas/route.js";
import type { Mode, RouteSummary } from "../schemas/stop.js";
import {
  asText,
  modeForRouteType,
  rowsFrom,
  type StopRoute,
  toRouteSummary,
  toStopSummary,
} from "./stops-repository.js";

const ROUTE_COLUMNS =
  "route_id, route_short_name, route_long_name, route_type, route_color";

function rowsFromRoutes(result: ResultSet): StopRoute[] {
  return result.rows.map((row) => ({
    route_id: Number(row.route_id),
    route_short_name:
      row.route_short_name === null ? null : asText(row.route_short_name),
    route_long_name:
      row.route_long_name === null ? null : asText(row.route_long_name),
    route_type: Number(row.route_type),
    route_color: row.route_color === null ? null : asText(row.route_color),
  }));
}

/** Full route catalog, optionally filtered by mode. Bounded set (~233 routes
 * for TTC) — no cap needed (docs/spec/tool-schemas.md #3 list_routes). */
export async function listRoutes(
  client: Client,
  mode?: Mode,
): Promise<RouteSummary[]> {
  const result = await client.execute(
    `SELECT ${ROUTE_COLUMNS} FROM routes ORDER BY route_id`,
  );
  const routes = rowsFromRoutes(result).map(toRouteSummary);
  return mode === undefined ? routes : routes.filter((r) => r.mode === mode);
}

/** `route_id -> mode` for the full catalog (bounded, ~233 routes) — the
 * static-catalog half of the RT alert join (docs/spec/realtime-integration.md
 * #4 "Static <-> RT join"): a GTFS-RT `EntitySelector` usually carries only a
 * `route_id`, not a `route_type`, so `get_alerts` resolves each informed
 * route's mode from here rather than the RT feed itself. */
export async function routeModeIndex(
  client: Client,
): Promise<Map<string, Mode>> {
  const result = await client.execute(
    "SELECT route_id, route_type FROM routes",
  );
  const index = new Map<string, Mode>();
  for (const row of result.rows) {
    const routeId = String(Number(row.route_id));
    index.set(routeId, modeForRouteType(Number(row.route_type)));
  }
  return index;
}

// GTFS technically allows a null trips.direction_id; TTC's feed doesn't
// leave it blank in practice, but coalesce to 0 rather than dropping the
// trip from its route's direction listing.
function directionIdOf(value: unknown): number {
  return value === null ? 0 : Number(value);
}

/**
 * One representative headsign per direction_id: the SQL groups by
 * (direction_id, trip_headsign) and orders by trip count desc (then
 * headsign for a deterministic tie-break), so the first row seen per
 * direction is the most common headsign for that direction.
 */
function pickDirections(result: ResultSet): RouteDirection[] {
  const seen = new Set<number>();
  const directions: RouteDirection[] = [];
  for (const row of result.rows) {
    const directionId = directionIdOf(row.direction_id);
    if (seen.has(directionId)) continue;
    seen.add(directionId);
    const headsign =
      row.trip_headsign === null ? "" : asText(row.trip_headsign);
    directions.push({ direction_id: directionId, headsign });
  }
  return directions;
}

interface CanonicalTrip {
  directionId: number;
  tripId: number;
}

/**
 * The trip used to represent each direction's stop sequence: the SQL groups
 * trips by stop count and orders by (direction_id, stop_count desc, trip_id)
 * so the first row seen per direction is the trip with the most stops
 * (longest pattern), tie-broken by the smallest trip_id.
 */
function pickCanonicalTrips(result: ResultSet): CanonicalTrip[] {
  const seen = new Set<number>();
  const trips: CanonicalTrip[] = [];
  for (const row of result.rows) {
    const directionId = directionIdOf(row.direction_id);
    if (seen.has(directionId)) continue;
    seen.add(directionId);
    trips.push({ directionId, tripId: Number(row.trip_id) });
  }
  return trips;
}

export const MAX_STOPS_PER_DIRECTION = 50;

export interface GetRouteOptions {
  /** Override for tests; anti-dump cap on stops-by-direction otherwise. */
  stopsPerDirectionLimit?: number;
}

/** A single route by id, with its directions and (capped) stops per direction. */
export async function getRouteById(
  client: Client,
  routeId: number,
  options: GetRouteOptions = {},
): Promise<RouteDetail | undefined> {
  const routeResult = await client.execute({
    sql: `SELECT ${ROUTE_COLUMNS} FROM routes WHERE route_id = ?`,
    args: [routeId],
  });
  const routeRow = rowsFromRoutes(routeResult)[0];
  if (!routeRow) return undefined;
  const summary = toRouteSummary(routeRow);

  const directionsResult = await client.execute({
    sql: `SELECT direction_id, trip_headsign, COUNT(*) AS cnt
          FROM trips
          WHERE route_id = ?
          GROUP BY direction_id, trip_headsign
          ORDER BY direction_id, cnt DESC, trip_headsign`,
    args: [routeId],
  });
  const directions = pickDirections(directionsResult);

  const canonicalResult = await client.execute({
    sql: `SELECT t.trip_id AS trip_id, t.direction_id AS direction_id,
                 COUNT(st.stop_id) AS stop_count
          FROM trips t
          JOIN stop_times st ON st.trip_id = t.trip_id
          WHERE t.route_id = ?
          GROUP BY t.trip_id
          ORDER BY t.direction_id, stop_count DESC, t.trip_id`,
    args: [routeId],
  });
  const canonicalTrips = pickCanonicalTrips(canonicalResult);

  const limit = options.stopsPerDirectionLimit ?? MAX_STOPS_PER_DIRECTION;
  let truncated = false;
  const stopsByDirection: RouteDirectionStops[] = [];
  for (const { directionId, tripId } of canonicalTrips) {
    const stopsResult = await client.execute({
      sql: `SELECT s.stop_id AS stop_id, s.stop_code AS stop_code,
                   s.stop_name AS stop_name, s.stop_lat AS stop_lat,
                   s.stop_lon AS stop_lon, s.parent_station AS parent_station,
                   s.location_type AS location_type
            FROM stop_times st
            JOIN stops s ON s.stop_id = st.stop_id
            WHERE st.trip_id = ?
            ORDER BY st.stop_sequence`,
      args: [tripId],
    });
    const rows = rowsFrom(stopsResult);
    if (rows.length > limit) truncated = true;
    const stops = rows
      .slice(0, limit)
      .map((row) => toStopSummary(row, summary.mode));
    stopsByDirection.push({ direction_id: directionId, stops });
  }

  return {
    ...summary,
    directions,
    ...(stopsByDirection.length > 0
      ? { stops_by_direction: stopsByDirection }
      : {}),
    truncated,
  };
}
