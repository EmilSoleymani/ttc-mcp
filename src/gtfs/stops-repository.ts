import type { Client, ResultSet } from "@libsql/client";

import type {
  Mode,
  RouteSummary,
  StopDetail,
  StopSummary,
} from "../schemas/stop.js";

// Mode is derived, not stored — a stop has no route_type of its own in GTFS.
// TTC's feed only ever uses route_type 0/1/3 (docs/spec/tool-schemas.md
// "Identity model"); a stop served by more than one mode (rare — mainly a
// subway station's parent row, resolved via its child platforms) reports the
// highest-priority one so `mode` stays a single required field.
const MODE_BY_ROUTE_TYPE: Readonly<Record<number, Mode>> = {
  0: "streetcar",
  1: "subway",
  3: "bus",
};
const MODE_PRIORITY: readonly Mode[] = ["subway", "streetcar", "bus"];

// The inverse of MODE_BY_ROUTE_TYPE, for pushing a `mode` filter into SQL
// (searchStopsByName's CANDIDATE_CEILING fix below) — TTC's mode<->route_type
// mapping is 1:1, so this inversion is lossless.
const ROUTE_TYPE_BY_MODE: Readonly<Record<Mode, number>> = Object.fromEntries(
  Object.entries(MODE_BY_ROUTE_TYPE).map(([routeType, mode]) => [
    mode,
    Number(routeType),
  ]),
) as Record<Mode, number>;

export function modeForRouteType(routeType: number): Mode {
  const mode = MODE_BY_ROUTE_TYPE[routeType];
  if (!mode) {
    throw new Error(
      `Unknown GTFS route_type ${String(routeType)} (TTC only uses 0/1/3)`,
    );
  }
  return mode;
}

/** The GTFS route_type for a mode — for pushing a `modes` filter into SQL. */
export function routeTypeForMode(mode: Mode): number {
  return ROUTE_TYPE_BY_MODE[mode];
}

function pickMode(routeTypes: Iterable<number>): Mode | undefined {
  const modes = new Set<Mode>();
  for (const routeType of routeTypes) modes.add(modeForRouteType(routeType));
  for (const mode of MODE_PRIORITY) if (modes.has(mode)) return mode;
  return undefined;
}

export interface StopRow {
  stop_id: number;
  stop_code: number | null;
  stop_name: string;
  stop_lat: number | null;
  stop_lon: number | null;
  parent_station: number | null;
  location_type: number | null;
}

export interface StopRoute {
  route_id: number;
  route_short_name: string | null;
  route_long_name: string | null;
  route_type: number;
  route_color: string | null;
}

export const STOP_COLUMNS =
  "stop_id, stop_code, stop_name, stop_lat, stop_lon, parent_station, location_type";

// libSQL's Value type includes ArrayBuffer (for BLOB columns), which has no
// meaningful String() representation; every column read here is a schema
// TEXT column, so narrow explicitly instead of blindly stringifying.
export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new Error("Expected a text column value from libSQL.");
}

export function rowsFrom(result: ResultSet): StopRow[] {
  return result.rows.map((row) => ({
    stop_id: Number(row.stop_id),
    stop_code: row.stop_code === null ? null : Number(row.stop_code),
    stop_name: asText(row.stop_name),
    stop_lat: row.stop_lat === null ? null : Number(row.stop_lat),
    stop_lon: row.stop_lon === null ? null : Number(row.stop_lon),
    parent_station:
      row.parent_station === null ? null : Number(row.parent_station),
    location_type:
      row.location_type === null ? null : Number(row.location_type),
  }));
}

export function toStopSummary(row: StopRow, mode: Mode): StopSummary {
  return {
    stop_id: String(row.stop_id),
    ...(row.stop_code !== null ? { stop_code: String(row.stop_code) } : {}),
    name: row.stop_name,
    mode,
    is_station: row.location_type === 1,
    ...(row.parent_station !== null
      ? { parent_station: String(row.parent_station) }
      : {}),
    // TTC's real feed always populates stop_lat/stop_lon; the column is
    // nullable only because raw GTFS technically allows it.
    lat: row.stop_lat ?? 0,
    lon: row.stop_lon ?? 0,
  };
}

// GTFS often leaves an optional text field as "" rather than NULL for a
// blank CSV cell (ingest passes it through as-is) — treat both as "absent".
export function presence(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

export function toRouteSummary(route: StopRoute): RouteSummary {
  const shortName = presence(route.route_short_name);
  const longName = presence(route.route_long_name);
  const color = presence(route.route_color);
  return {
    route_id: String(route.route_id),
    ...(shortName !== undefined ? { route_short_name: shortName } : {}),
    ...(longName !== undefined ? { route_long_name: longName } : {}),
    mode: modeForRouteType(route.route_type),
    ...(color !== undefined ? { color } : {}),
  };
}

/** Child platform rows (location_type = 0) of the given station ids. */
async function fetchChildRows(
  client: Client,
  parentIds: number[],
): Promise<Map<number, StopRow[]>> {
  if (parentIds.length === 0) return new Map();
  const placeholders = parentIds.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT ${STOP_COLUMNS} FROM stops WHERE parent_station IN (${placeholders})`,
    args: parentIds,
  });
  const map = new Map<number, StopRow[]>();
  for (const row of rowsFrom(result)) {
    if (row.parent_station === null) continue;
    const list = map.get(row.parent_station);
    if (list) list.push(row);
    else map.set(row.parent_station, [row]);
  }
  return map;
}

/** Routes serving each of the given stop ids (bulk, one query for the batch). */
async function fetchRoutesByStopIds(
  client: Client,
  stopIds: number[],
): Promise<Map<number, StopRoute[]>> {
  if (stopIds.length === 0) return new Map();
  const placeholders = stopIds.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT DISTINCT st.stop_id AS stop_id, r.route_id AS route_id,
                 r.route_short_name AS route_short_name,
                 r.route_long_name AS route_long_name,
                 r.route_type AS route_type, r.route_color AS route_color
          FROM stop_times st
          JOIN trips t ON t.trip_id = st.trip_id
          JOIN routes r ON r.route_id = t.route_id
          WHERE st.stop_id IN (${placeholders})`,
    args: stopIds,
  });
  const map = new Map<number, StopRoute[]>();
  for (const row of result.rows) {
    const stopId = Number(row.stop_id);
    const route: StopRoute = {
      route_id: Number(row.route_id),
      route_short_name:
        row.route_short_name === null ? null : asText(row.route_short_name),
      route_long_name:
        row.route_long_name === null ? null : asText(row.route_long_name),
      route_type: Number(row.route_type),
      route_color: row.route_color === null ? null : asText(row.route_color),
    };
    const list = map.get(stopId);
    if (list) list.push(route);
    else map.set(stopId, [route]);
  }
  return map;
}

interface ResolvedStop {
  mode: Mode | undefined;
  routes: StopRoute[];
}

/**
 * Resolves each stop's mode + serving routes, unioned with its child
 * platforms' routes so a station (which itself carries no stop_times rows)
 * still reports the mode of the platforms it aggregates.
 */
async function resolveModesAndRoutes(
  client: Client,
  stopRows: StopRow[],
  childrenByParent: Map<number, StopRow[]>,
): Promise<Map<number, ResolvedStop>> {
  const allIds = new Set<number>();
  for (const row of stopRows) {
    allIds.add(row.stop_id);
    for (const child of childrenByParent.get(row.stop_id) ?? []) {
      allIds.add(child.stop_id);
    }
  }
  const routesByStop = await fetchRoutesByStopIds(client, [...allIds]);

  const result = new Map<number, ResolvedStop>();
  for (const row of stopRows) {
    const effectiveIds = [
      row.stop_id,
      ...(childrenByParent.get(row.stop_id) ?? []).map((c) => c.stop_id),
    ];
    const routeMap = new Map<number, StopRoute>();
    for (const id of effectiveIds) {
      for (const route of routesByStop.get(id) ?? []) {
        routeMap.set(route.route_id, route);
      }
    }
    const routes = [...routeMap.values()];
    result.set(row.stop_id, {
      mode: pickMode(routes.map((r) => r.route_type)),
      routes,
    });
  }
  return result;
}

export interface StopSearchOptions {
  mode?: Mode;
  limit?: number;
}

export interface StopSearchResult {
  stops: StopSummary[];
  truncated: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
// Raw candidates fetched before mode-resolution + capping, so a mode filter
// doesn't starve the final page (anti-dump cap applies after filtering).
const CANDIDATE_CEILING = 200;

async function finishSearch(
  client: Client,
  rows: StopRow[],
  options: StopSearchOptions,
): Promise<StopSearchResult> {
  const childrenByParent = await fetchChildRows(
    client,
    rows.map((r) => r.stop_id),
  );
  const resolved = await resolveModesAndRoutes(client, rows, childrenByParent);
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const withMode = rows
    .map((row) => ({ row, mode: resolved.get(row.stop_id)?.mode }))
    .filter(
      (entry): entry is { row: StopRow; mode: Mode } =>
        entry.mode !== undefined,
    )
    .filter(
      (entry) => options.mode === undefined || entry.mode === options.mode,
    );

  const truncated = withMode.length > limit;
  const stops = withMode
    .slice(0, limit)
    .map((entry) => toStopSummary(entry.row, entry.mode));
  return { stops, truncated };
}

/**
 * Name search (substring, case-insensitive). When a `mode` filter is given,
 * the mode participates in the SQL candidate query itself — a stop (or, for
 * a station, any of its child platforms) must be served by a route of that
 * mode — rather than being applied only after the CANDIDATE_CEILING cap.
 * Without this, a mode-matching stop whose name sorts alphabetically after
 * CANDIDATE_CEILING-many mode-mismatched name matches would never make it
 * into the candidate pool at all (#24).
 */
export async function searchStopsByName(
  client: Client,
  query: string,
  options: StopSearchOptions = {},
): Promise<StopSearchResult> {
  const namePattern = `%${query}%`;

  if (options.mode === undefined) {
    const result = await client.execute({
      sql: `SELECT ${STOP_COLUMNS} FROM stops
            WHERE stop_name LIKE ? COLLATE NOCASE
            ORDER BY stop_name
            LIMIT ?`,
      args: [namePattern, CANDIDATE_CEILING],
    });
    return finishSearch(client, rowsFrom(result), options);
  }

  const routeType = ROUTE_TYPE_BY_MODE[options.mode];
  const result = await client.execute({
    sql: `SELECT ${STOP_COLUMNS} FROM stops s
          WHERE s.stop_name LIKE ? COLLATE NOCASE
            AND (
              EXISTS (
                SELECT 1 FROM stop_times st
                JOIN trips t ON t.trip_id = st.trip_id
                JOIN routes r ON r.route_id = t.route_id
                WHERE st.stop_id = s.stop_id AND r.route_type = ?
              )
              OR EXISTS (
                SELECT 1 FROM stops c
                JOIN stop_times st ON st.stop_id = c.stop_id
                JOIN trips t ON t.trip_id = st.trip_id
                JOIN routes r ON r.route_id = t.route_id
                WHERE c.parent_station = s.stop_id AND r.route_type = ?
              )
            )
          ORDER BY s.stop_name
          LIMIT ?`,
    args: [namePattern, routeType, routeType, CANDIDATE_CEILING],
  });
  // finishSearch still re-applies the mode filter: this SQL query is
  // deliberately broader (any route of the requested mode at the stop or a
  // child platform), while a stop's *resolved* mode (used for equality here
  // and for the returned DTO) is priority-tie-broken across all of its
  // modes (MODE_PRIORITY) — the two can disagree for a genuinely
  // multi-mode station, and the tie-broken single-mode field must win.
  return finishSearch(client, rowsFrom(result), options);
}

const METERS_PER_DEGREE_LAT = 111_320;
const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Proximity search: a SQL bounding-box pre-filter (stops has no spatial
 * index, but ~9k rows makes a box-bounded scan cheap), then exact haversine
 * distance + sort in JS.
 */
export async function searchStopsNear(
  client: Client,
  lat: number,
  lon: number,
  radiusM: number,
  options: StopSearchOptions = {},
): Promise<StopSearchResult> {
  const latDelta = radiusM / METERS_PER_DEGREE_LAT;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lonDelta = radiusM / (METERS_PER_DEGREE_LAT * (cosLat || 1e-9));
  const result = await client.execute({
    sql: `SELECT ${STOP_COLUMNS} FROM stops
          WHERE stop_lat BETWEEN ? AND ? AND stop_lon BETWEEN ? AND ?`,
    args: [lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta],
  });

  const withinRadius = rowsFrom(result)
    .filter(
      (row): row is StopRow & { stop_lat: number; stop_lon: number } =>
        row.stop_lat !== null && row.stop_lon !== null,
    )
    .map((row) => ({
      row,
      distance: haversineMeters(lat, lon, row.stop_lat, row.stop_lon),
    }))
    .filter((entry) => entry.distance <= radiusM)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, CANDIDATE_CEILING)
    .map((entry) => entry.row);

  return finishSearch(client, withinRadius, options);
}

/** A single stop/station by id, with platforms (for a station) and serving routes. */
export async function getStopById(
  client: Client,
  stopId: number,
): Promise<StopDetail | undefined> {
  const result = await client.execute({
    sql: `SELECT ${STOP_COLUMNS} FROM stops WHERE stop_id = ?`,
    args: [stopId],
  });
  const row = rowsFrom(result)[0];
  if (!row) return undefined;

  const childrenByParent = await fetchChildRows(client, [row.stop_id]);
  const resolved = await resolveModesAndRoutes(client, [row], childrenByParent);
  const own = resolved.get(row.stop_id);
  // No route serves this stop or any of its platforms — nothing to report.
  if (!own?.mode) return undefined;

  const platformRows = childrenByParent.get(row.stop_id) ?? [];
  const platformResolved =
    platformRows.length > 0
      ? await resolveModesAndRoutes(client, platformRows, new Map())
      : new Map<number, ResolvedStop>();
  const platforms = platformRows
    .map((p) => ({ row: p, mode: platformResolved.get(p.stop_id)?.mode }))
    .filter(
      (entry): entry is { row: StopRow; mode: Mode } =>
        entry.mode !== undefined,
    )
    .map((entry) => toStopSummary(entry.row, entry.mode));

  return {
    ...toStopSummary(row, own.mode),
    ...(platforms.length > 0 ? { platforms } : {}),
    routes: own.routes.map(toRouteSummary),
  };
}

/** `stop_id -> {route_type}` served directly (one DISTINCT scan of the whole
 * feed), the catalog-wide half of the stop-mode resolution below. */
async function fetchRouteTypesByStopId(
  client: Client,
): Promise<Map<number, Set<number>>> {
  const result = await client.execute(
    `SELECT DISTINCT st.stop_id AS stop_id, r.route_type AS route_type
     FROM stop_times st
     JOIN trips t ON t.trip_id = st.trip_id
     JOIN routes r ON r.route_id = t.route_id`,
  );
  const routeTypesByStop = new Map<number, Set<number>>();
  for (const row of result.rows) {
    const stopId = Number(row.stop_id);
    const routeType = Number(row.route_type);
    const set = routeTypesByStop.get(stopId);
    if (set) set.add(routeType);
    else routeTypesByStop.set(stopId, new Set([routeType]));
  }
  return routeTypesByStop;
}

/** parent_station -> its child platform stop_ids, over the whole catalog. */
function childStopIdsByParent(rows: StopRow[]): Map<number, number[]> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    if (row.parent_station === null) continue;
    const list = childrenByParent.get(row.parent_station);
    if (list) list.push(row.stop_id);
    else childrenByParent.set(row.parent_station, [row.stop_id]);
  }
  return childrenByParent;
}

/** The resolved (priority-tie-broken) mode of a stop, unioning its own routes
 * with its child platforms' — a station carries no stop_times of its own. */
function resolveStopMode(
  stopId: number,
  routeTypesByStop: Map<number, Set<number>>,
  childrenByParent: Map<number, number[]>,
): Mode | undefined {
  const routeTypes = new Set<number>(routeTypesByStop.get(stopId) ?? []);
  for (const childId of childrenByParent.get(stopId) ?? []) {
    for (const rt of routeTypesByStop.get(childId) ?? []) routeTypes.add(rt);
  }
  return pickMode(routeTypes);
}

/**
 * `stop_id -> mode` for the full catalog — the static-catalog stop half of the
 * RT alert join (docs/spec/realtime-integration.md #4): a GTFS-RT alert can
 * inform a `stop_id` (e.g. a subway station) with no `route_id`, so `get_alerts`
 * resolves that stop's mode from here. Keyed by the canonical (numeric-string)
 * stop_id so an RT `stop_id` string looks up directly. Stops served by no route
 * (e.g. subway entrances) are omitted.
 */
export async function stopModeIndex(
  client: Client,
): Promise<Map<string, Mode>> {
  const rows = rowsFrom(
    await client.execute(`SELECT ${STOP_COLUMNS} FROM stops`),
  );
  const routeTypesByStop = await fetchRouteTypesByStopId(client);
  const childrenByParent = childStopIdsByParent(rows);

  const index = new Map<string, Mode>();
  for (const row of rows) {
    const mode = resolveStopMode(
      row.stop_id,
      routeTypesByStop,
      childrenByParent,
    );
    if (mode !== undefined) index.set(String(row.stop_id), mode);
  }
  return index;
}

/** Full stop catalog for the ttc://stops resource — unfiltered, uncapped. */
export async function listStops(client: Client): Promise<StopSummary[]> {
  const stopsResult = await client.execute(`SELECT ${STOP_COLUMNS} FROM stops`);
  const rows = rowsFrom(stopsResult);

  const routeTypesByStop = await fetchRouteTypesByStopId(client);
  const childrenByParent = childStopIdsByParent(rows);

  const stops: StopSummary[] = [];
  for (const row of rows) {
    const mode = resolveStopMode(
      row.stop_id,
      routeTypesByStop,
      childrenByParent,
    );
    // Non-transit rows (e.g. subway entrances with no trips) aren't stops the
    // API can usefully return.
    if (mode === undefined) continue;
    stops.push(toStopSummary(row, mode));
  }
  return stops;
}
