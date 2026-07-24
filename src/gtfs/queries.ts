import type { Client, Row } from "@libsql/client";

/**
 * The load-bearing query the `ix_st_stop_dep` index exists for: the next N
 * scheduled departures at a stop from a given time-of-day. This is the raw,
 * schema-level building block — service-day resolution (`calendar` +
 * `calendar_dates`), station/platform aggregation, and DTO shaping belong to
 * the `get_schedule` tool (issue #7), not the ingest layer.
 */
const NEXT_DEPARTURES_SQL = `
  SELECT trip_id, stop_sequence, arr, dep
  FROM stop_times
  WHERE stop_id = ? AND dep >= ?
  ORDER BY dep
  LIMIT ?
`;

export async function nextDepartures(
  client: Client,
  stopId: number,
  afterSeconds: number,
  limit: number,
): Promise<Row[]> {
  const result = await client.execute({
    sql: NEXT_DEPARTURES_SQL,
    args: [stopId, afterSeconds, limit],
  });
  return result.rows;
}

/** Query plan for the next-departures query, for asserting index usage in tests/CI. */
export async function explainNextDeparturesPlan(
  client: Client,
  stopId: number,
  afterSeconds: number,
  limit: number,
): Promise<string[]> {
  const result = await client.execute({
    sql: `EXPLAIN QUERY PLAN ${NEXT_DEPARTURES_SQL}`,
    args: [stopId, afterSeconds, limit],
  });
  return result.rows.map((row) => {
    const detail = row["detail"];
    return typeof detail === "string" ? detail : "";
  });
}
