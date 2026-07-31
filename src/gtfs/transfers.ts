import type { Client, InValue } from "@libsql/client";

// The synthesized transfers table (docs/spec/gtfs-ingestion.md, plan-trip.md
// "Transfer model"): the missing transfers.txt, generated once at ingest from
// three sources, in priority order when a stop pair qualifies for more than
// one (station is free/authoritative, pathway is measured, street is a
// coarse geometric fallback).
export type TransferType = "station" | "pathway" | "street";

export interface TransferRow {
  from_stop_id: number;
  to_stop_id: number;
  min_walk_seconds: number;
  type: TransferType;
}

export interface StopIdentity {
  stop_id: number;
  parent_station: number | null;
  stop_lat: number | null;
  stop_lon: number | null;
  location_type: number | null;
}

export interface PathwayIdentity {
  from_stop_id: number;
  to_stop_id: number;
  is_bidirectional: number | null;
  traversal_time: number | null;
  length: number | null;
}

const WALK_SPEED_MPS = 1.3;
// A short, fixed in-station walk between platforms sharing a parent_station
// — cheap to board, unlike a measured pathway or a geometric street walk.
const STATION_TRANSFER_SECONDS = 60;
const STREET_RADIUS_M = 250;
const METERS_PER_DEGREE_LAT = 111_320;
const EARTH_RADIUS_M = 6_371_000;

/** station-type: stops sharing a parent_station, connected both ways. */
export function buildStationTransfers(
  stops: readonly StopIdentity[],
): TransferRow[] {
  const byParent = new Map<number, number[]>();
  for (const stop of stops) {
    if (stop.parent_station === null) continue;
    const list = byParent.get(stop.parent_station);
    if (list) list.push(stop.stop_id);
    else byParent.set(stop.parent_station, [stop.stop_id]);
  }

  const transfers: TransferRow[] = [];
  for (const siblings of byParent.values()) {
    for (const from of siblings) {
      for (const to of siblings) {
        if (from === to) continue;
        transfers.push({
          from_stop_id: from,
          to_stop_id: to,
          min_walk_seconds: STATION_TRANSFER_SECONDS,
          type: "station",
        });
      }
    }
  }
  return transfers;
}

function pathwayWalkSeconds(pathway: PathwayIdentity): number {
  if (pathway.traversal_time !== null) return pathway.traversal_time;
  if (pathway.length !== null) {
    return Math.round(pathway.length / WALK_SPEED_MPS);
  }
  // Dataset B pathways lacking both fields are rare; fall back to the same
  // fixed in-station estimate a station-type transfer would use.
  return STATION_TRANSFER_SECONDS;
}

interface PathwayEdge {
  to: number;
  seconds: number;
}

function buildPathwayGraph(
  pathways: readonly PathwayIdentity[],
): Map<number, PathwayEdge[]> {
  const graph = new Map<number, PathwayEdge[]>();
  const addEdge = (from: number, to: number, seconds: number): void => {
    const list = graph.get(from);
    const edge = { to, seconds };
    if (list) list.push(edge);
    else graph.set(from, [edge]);
  };
  for (const pathway of pathways) {
    const seconds = pathwayWalkSeconds(pathway);
    addEdge(pathway.from_stop_id, pathway.to_stop_id, seconds);
    if (pathway.is_bidirectional === 1) {
      addEdge(pathway.to_stop_id, pathway.from_stop_id, seconds);
    }
  }
  return graph;
}

// Station pathway graphs are small (at most a few dozen nodes per complex),
// so an O(V²) Dijkstra per source is plenty fast — no priority queue needed.
function shortestWalkSeconds(
  graph: Map<number, PathwayEdge[]>,
  source: number,
): Map<number, number> {
  const dist = new Map<number, number>([[source, 0]]);
  const visited = new Set<number>();
  for (;;) {
    let current: number | undefined;
    let currentDist = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < currentDist) {
        current = node;
        currentDist = d;
      }
    }
    if (current === undefined) break;
    visited.add(current);
    for (const edge of graph.get(current) ?? []) {
      const candidate = currentDist + edge.seconds;
      const existing = dist.get(edge.to);
      if (existing === undefined || candidate < existing) {
        dist.set(edge.to, candidate);
      }
    }
  }
  return dist;
}

/**
 * pathway-type: walk times between real (boardable) stops derived from
 * Dataset B's pathway graph. A GTFS pathway graph routes through
 * intermediate structural nodes (fare gates, concourses, stairs) that are
 * defined in Dataset B's own stops.txt — which isn't ingested here, so those
 * node ids never appear in `knownStopIds` — the pathway between two
 * platforms is frequently multi-hop through such nodes rather than a single
 * direct edge. Treating the raw pathways as a graph and running
 * shortest-path from each known stop (summing traversal time across hops)
 * finds the real walk even though the intermediate nodes themselves are
 * never exposed as transfer endpoints.
 */
export function buildPathwayTransfers(
  pathways: readonly PathwayIdentity[],
  knownStopIds: ReadonlySet<number>,
): TransferRow[] {
  const graph = buildPathwayGraph(pathways);

  const nodeIds = new Set<number>();
  for (const pathway of pathways) {
    nodeIds.add(pathway.from_stop_id);
    nodeIds.add(pathway.to_stop_id);
  }
  const sources = [...nodeIds].filter((id) => knownStopIds.has(id));

  const transfers: TransferRow[] = [];
  for (const source of sources) {
    const distances = shortestWalkSeconds(graph, source);
    for (const [nodeId, seconds] of distances) {
      if (nodeId === source || !knownStopIds.has(nodeId)) continue;
      transfers.push({
        from_stop_id: source,
        to_stop_id: nodeId,
        min_walk_seconds: seconds,
        type: "pathway",
      });
    }
  }
  return transfers;
}

function haversineMeters(
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
 * street-type: stops within `radiusM` of each other (haversine), walk time =
 * distance ÷ walkSpeedMps. A naive all-pairs scan is O(n²) — with ~9,361 TTC
 * stops that's ~88M pairs, so candidates are pre-filtered with a lat/lon grid
 * sized to the radius (check each stop's cell + its 8 neighbors only).
 */
export function buildStreetTransfers(
  stops: readonly StopIdentity[],
  radiusM = STREET_RADIUS_M,
  walkSpeedMps = WALK_SPEED_MPS,
): TransferRow[] {
  // location_type === 1 rows are non-boardable station parents (Dataset B's
  // station hierarchy) — they carry lat/lon but no vehicle ever stops there,
  // so they're excluded from street transfers.
  const located = stops.filter(
    (s): s is StopIdentity & { stop_lat: number; stop_lon: number } =>
      s.location_type !== 1 && s.stop_lat !== null && s.stop_lon !== null,
  );
  if (located.length === 0) return [];

  // A single reference latitude keeps the grid uniform, which is an
  // acceptable approximation for a city-scale area like Toronto.
  const refLat = located[0]!.stop_lat;
  const latCellDeg = radiusM / METERS_PER_DEGREE_LAT;
  const lonCellDeg =
    radiusM /
    (METERS_PER_DEGREE_LAT * (Math.cos((refLat * Math.PI) / 180) || 1e-9));

  const cellOf = (lat: number, lon: number): [number, number] => [
    Math.floor(lat / latCellDeg),
    Math.floor(lon / lonCellDeg),
  ];
  const gridKey = (latIdx: number, lonIdx: number): string =>
    `${latIdx},${lonIdx}`;

  const grid = new Map<string, (typeof located)[number][]>();
  for (const stop of located) {
    const [latIdx, lonIdx] = cellOf(stop.stop_lat, stop.stop_lon);
    const key = gridKey(latIdx, lonIdx);
    const list = grid.get(key);
    if (list) list.push(stop);
    else grid.set(key, [stop]);
  }

  const transfers: TransferRow[] = [];
  const processedPairs = new Set<string>();
  for (const stop of located) {
    const [latIdx, lonIdx] = cellOf(stop.stop_lat, stop.stop_lon);
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const neighbors = grid.get(gridKey(latIdx + dLat, lonIdx + dLon)) ?? [];
        for (const other of neighbors) {
          if (other.stop_id === stop.stop_id) continue;
          const [aId, bId] =
            stop.stop_id < other.stop_id
              ? [stop.stop_id, other.stop_id]
              : [other.stop_id, stop.stop_id];
          const pairKey = `${String(aId)}:${String(bId)}`;
          if (processedPairs.has(pairKey)) continue;
          processedPairs.add(pairKey);

          const distance = haversineMeters(
            stop.stop_lat,
            stop.stop_lon,
            other.stop_lat,
            other.stop_lon,
          );
          if (distance > radiusM) continue;
          const seconds = Math.round(distance / walkSpeedMps);
          transfers.push({
            from_stop_id: stop.stop_id,
            to_stop_id: other.stop_id,
            min_walk_seconds: seconds,
            type: "street",
          });
          transfers.push({
            from_stop_id: other.stop_id,
            to_stop_id: stop.stop_id,
            min_walk_seconds: seconds,
            type: "street",
          });
        }
      }
    }
  }
  return transfers;
}

const TYPE_PRIORITY: Readonly<Record<TransferType, number>> = {
  station: 0,
  pathway: 1,
  street: 2,
};

/**
 * Combines transfer groups, keeping at most one row per directed
 * (from_stop_id, to_stop_id) pair — the highest-priority type wins
 * (station > pathway > street) rather than emitting redundant/conflicting
 * walk times for the same pair.
 */
export function mergeTransfers(
  ...groups: readonly (readonly TransferRow[])[]
): TransferRow[] {
  const byPair = new Map<string, TransferRow>();
  for (const group of groups) {
    for (const transfer of group) {
      const key = `${String(transfer.from_stop_id)}:${String(transfer.to_stop_id)}`;
      const existing = byPair.get(key);
      if (
        !existing ||
        TYPE_PRIORITY[transfer.type] < TYPE_PRIORITY[existing.type]
      ) {
        byPair.set(key, transfer);
      }
    }
  }
  return [...byPair.values()];
}

const INSERT_CHUNK_ROWS = 200;

/** Bulk-inserts transfer rows into the transfers table in one write transaction. */
export async function insertTransfers(
  client: Client,
  transfers: readonly TransferRow[],
): Promise<number> {
  if (transfers.length === 0) return 0;
  const rowPlaceholder = "(?, ?, ?, ?)";
  const tx = await client.transaction("write");
  try {
    for (let i = 0; i < transfers.length; i += INSERT_CHUNK_ROWS) {
      const chunk = transfers.slice(i, i + INSERT_CHUNK_ROWS);
      const args: InValue[] = chunk.flatMap((t) => [
        t.from_stop_id,
        t.to_stop_id,
        t.min_walk_seconds,
        t.type,
      ]);
      const values = chunk.map(() => rowPlaceholder).join(", ");
      await tx.execute({
        sql: `INSERT INTO transfers (from_stop_id, to_stop_id, min_walk_seconds, type) VALUES ${values}`,
        args,
      });
    }
    await tx.commit();
    return transfers.length;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
