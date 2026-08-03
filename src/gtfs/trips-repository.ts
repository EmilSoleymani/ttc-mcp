import type { Client } from "@libsql/client";

import { asText, presence } from "./stops-repository.js";
import { toInt } from "./transform.js";

/**
 * The static-trip enrichment `get_arrivals` splices onto an RT prediction:
 * the human-readable `route_short_name`/`headsign`/`direction_id` a bare
 * GTFS-RT `stop_time_update` lacks (docs/spec/realtime-integration.md #3/#4).
 */
export interface StaticTrip {
  trip_id: number;
  route_id: number;
  route_short_name?: string;
  headsign?: string;
  direction_id?: number;
}

/**
 * Reconciles a GTFS-RT `trip_id` (a wire string) to the static `trips`
 * primary key, which the ingest pipeline stored as an INTEGER via the same
 * `toInt` (src/gtfs/ingest.ts, src/gtfs/schema.ts — `trip_id INTEGER PRIMARY
 * KEY`). Running the RT side through the identical parse is what makes the
 * join well-defined: any numeric `trip_id` collapses to the same integer on
 * both sides, and a non-numeric one yields `null` — which the join treats as
 * "no match, use the never-drop fallback" rather than a hard error.
 * (docs/research/rt-trip-id-join.md).
 */
export function parseRtTripId(
  rtTripId: string | null | undefined,
): number | null {
  return toInt(rtTripId ?? undefined);
}

function toStaticTrip(row: Record<string, unknown>): StaticTrip {
  const shortName = presence(
    row.route_short_name === null ? null : asText(row.route_short_name),
  );
  const headsign = presence(
    row.trip_headsign === null ? null : asText(row.trip_headsign),
  );
  const trip: StaticTrip = {
    trip_id: Number(row.trip_id),
    route_id: Number(row.route_id),
  };
  if (shortName !== undefined) trip.route_short_name = shortName;
  if (headsign !== undefined) trip.headsign = headsign;
  if (row.direction_id !== null && row.direction_id !== undefined) {
    trip.direction_id = Number(row.direction_id);
  }
  return trip;
}

const TRIP_COLUMNS =
  "t.trip_id AS trip_id, t.route_id AS route_id, t.trip_headsign AS trip_headsign, t.direction_id AS direction_id, r.route_short_name AS route_short_name";

/** A single static trip (joined to its route for `route_short_name`) by its
 * integer id, or `undefined` when the id isn't in the ingested feed. */
export async function getStaticTripById(
  client: Client,
  tripId: number,
): Promise<StaticTrip | undefined> {
  const result = await client.execute({
    sql: `SELECT ${TRIP_COLUMNS}
          FROM trips t JOIN routes r ON r.route_id = t.route_id
          WHERE t.trip_id = ?`,
    args: [tripId],
  });
  const row = result.rows[0];
  return row ? toStaticTrip(row) : undefined;
}

// libSQL/SQLite caps bound parameters per statement (~variable limit); chunk
// the `IN (...)` existence probe well under it. The overlap measurement
// (src/entry/validate-rt-join.ts) only passes the *distinct* RT trip_ids in a
// single feed sample, so a handful of chunks covers a full feed.
const EXISTS_CHUNK = 500;

/**
 * The subset of `tripIds` that exist in the ingested static `trips` table —
 * the batch existence probe the RT↔static overlap measurement uses. Ids are
 * already-parsed integers (see `parseRtTripId`).
 */
export async function staticTripIdsExisting(
  client: Client,
  tripIds: number[],
): Promise<Set<number>> {
  const found = new Set<number>();
  const unique = [...new Set(tripIds)];
  for (let i = 0; i < unique.length; i += EXISTS_CHUNK) {
    const chunk = unique.slice(i, i + EXISTS_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await client.execute({
      sql: `SELECT trip_id FROM trips WHERE trip_id IN (${placeholders})`,
      args: chunk,
    });
    for (const row of result.rows) found.add(Number(row.trip_id));
  }
  return found;
}

/** Total ingested static trip count — the denominator context for the
 * overlap report. */
export async function countStaticTrips(client: Client): Promise<number> {
  const result = await client.execute("SELECT COUNT(*) AS n FROM trips");
  return Number(result.rows[0]?.n ?? 0);
}
