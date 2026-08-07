#!/usr/bin/env node
// Research/measurement harness for #33: how often does the stop-sequence
// pattern match actually recover a live trip's direction/headsign against the
// real feed? Samples one live TripUpdates feed, crosswalks each trip's stop
// list to static stop_ids, matches it back to the route's static patterns, and
// reports the recovery rate (plus the terminal-text fallback coverage for the
// misses). Prints a human report to stderr and a machine-readable JSON summary
// to stdout.
//
// Requires: an ingested schedule DB (`npm run ingest`, LIBSQL_URL) AND
// outbound network to the TTC RT endpoint (GTFS_RT_BASE_URL). Not runnable in
// a network-restricted sandbox — see docs/research/headsign-recovery.md for
// the methodology and the numbers a maintainer run produces.
import type { Client } from "@libsql/client";
import type { transit_realtime } from "gtfs-realtime-bindings";

import { resolveQueryClient } from "../gtfs/db-client.js";
import { asText } from "../gtfs/stops-repository.js";
import {
  loadRoutePatterns,
  matchPattern,
  type RoutePattern,
} from "../gtfs-rt/pattern-match.js";
import { resolveRtClient } from "../gtfs-rt/rt-client.js";

interface RecoveryReport {
  rt_trip_updates: number;
  trips_with_route: number;
  trips_with_crosswalked_stops: number;
  recovered: number;
  recovery_pct: number;
  fallback_terminal_text: number;
  unrecoverable: number;
  sample_recovered: {
    route_id: string;
    headsign: string;
    direction_id: number;
  }[];
}

async function crosswalkAll(
  client: Client,
  rtStopIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const numeric = [...new Set(rtStopIds)]
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const CHUNK = 500;
  for (let i = 0; i < numeric.length; i += CHUNK) {
    const chunk = numeric.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await client.execute({
      sql: `SELECT rt_stop_id, stop_id FROM rt_stop_crosswalk WHERE rt_stop_id IN (${placeholders})`,
      args: chunk,
    });
    for (const row of result.rows) {
      map.set(String(Number(row.rt_stop_id)), Number(row.stop_id));
    }
  }
  return map;
}

function stopListOf(u: transit_realtime.ITripUpdate): string[] {
  return (u.stopTimeUpdate ?? [])
    .map((stu) => stu.stopId)
    .filter((id): id is string => id !== null && id !== undefined);
}

const client = resolveQueryClient();
const rt = resolveRtClient();
const updates = await rt.getTripUpdates();

const crosswalk = await crosswalkAll(client, updates.flatMap(stopListOf));

const patternCache = new Map<string, RoutePattern[]>();
const patternsFor = async (route: string): Promise<RoutePattern[]> => {
  const cached = patternCache.get(route);
  if (cached) return cached;
  const loaded = await loadRoutePatterns(client, route);
  patternCache.set(route, loaded);
  return loaded;
};

let tripsWithRoute = 0;
let tripsWithStops = 0;
let recovered = 0;
let fallback = 0;
let unrecoverable = 0;
const sampleRecovered: RecoveryReport["sample_recovered"] = [];

for (const u of updates) {
  const routeId = u.trip?.routeId;
  if (routeId == null || routeId === "") continue;
  tripsWithRoute++;

  const staticSeq = stopListOf(u)
    .map((id) => crosswalk.get(id))
    .filter((id): id is number => id !== undefined);
  if (staticSeq.length === 0) continue;
  tripsWithStops++;

  // Mirror the runtime path: attribute the arrival at the trip's next stop
  // (first in its remaining stop list, which is what a rider there queries).
  const queriedStop = staticSeq[0]!;
  const match = matchPattern(
    staticSeq,
    await patternsFor(routeId),
    queriedStop,
  );
  if (match) {
    recovered++;
    if (sampleRecovered.length < 10) {
      sampleRecovered.push({ route_id: routeId, ...match });
    }
  } else {
    // The runtime fallback still names the terminal if it crosswalks.
    const terminal = staticSeq[staticSeq.length - 1]!;
    const nameRow = await client.execute({
      sql: "SELECT stop_name FROM stops WHERE stop_id = ?",
      args: [terminal],
    });
    if (nameRow.rows[0]?.stop_name != null) fallback++;
    else unrecoverable++;
  }
}

const report: RecoveryReport = {
  rt_trip_updates: updates.length,
  trips_with_route: tripsWithRoute,
  trips_with_crosswalked_stops: tripsWithStops,
  recovered,
  recovery_pct:
    tripsWithStops === 0
      ? 0
      : Math.round((recovered / tripsWithStops) * 1000) / 10,
  fallback_terminal_text: fallback,
  unrecoverable,
  sample_recovered: sampleRecovered.map((s) => ({
    route_id: s.route_id,
    headsign: asText(s.headsign),
    direction_id: s.direction_id,
  })),
};

console.error("=== get_arrivals headsign/direction recovery (#33) ===");
console.error(`Live TripUpdates in sample:   ${String(updates.length)}`);
console.error(`  with a route_id:            ${String(tripsWithRoute)}`);
console.error(`  with crosswalked stops:     ${String(tripsWithStops)}`);
console.error(
  `Pattern-matched (recovered):  ${String(recovered)} (${String(report.recovery_pct)}% of crosswalked)`,
);
console.error(`Terminal-text fallback:       ${String(fallback)}`);
console.error(`Unrecoverable (no terminal):  ${String(unrecoverable)}`);
if (report.sample_recovered.length > 0) {
  console.error("Sample recovered:");
  for (const s of report.sample_recovered) {
    console.error(
      `  route ${s.route_id} dir ${String(s.direction_id)} → ${s.headsign}`,
    );
  }
}

console.log(JSON.stringify(report, null, 2));
