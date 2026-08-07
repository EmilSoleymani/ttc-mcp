import type { Client } from "@libsql/client";

import type { ScheduledDeparture } from "../schemas/schedule.js";
import type { StopDetail, StopSummary } from "../schemas/stop.js";
import {
  addDays,
  absoluteTimeFor,
  secondsSinceServiceMidnight,
  type ServiceDate,
  serviceDateAt,
  toIsoWithTorontoOffset,
  toYyyymmdd,
  weekdayOf,
} from "./service-time.js";
import { asText, getStopById, presence } from "./stops-repository.js";

const WEEKDAY_COLUMNS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Service ids active on a given service date, per `calendar` + the
 * `calendar_dates` add/remove exceptions for that date. Exported for the
 * plan_trip routing layer, which resolves service days the same way. */
export async function activeServiceIds(
  client: Client,
  date: ServiceDate,
): Promise<number[]> {
  const yyyymmdd = toYyyymmdd(date);
  const dowColumn = WEEKDAY_COLUMNS[weekdayOf(date)];

  const calendarResult = await client.execute({
    sql: `SELECT service_id FROM calendar WHERE start_date <= ? AND end_date >= ? AND ${dowColumn} = 1`,
    args: [yyyymmdd, yyyymmdd],
  });
  const active = new Set<number>(
    calendarResult.rows.map((row) => Number(row.service_id)),
  );

  const exceptionsResult = await client.execute({
    sql: `SELECT service_id, exception_type FROM calendar_dates WHERE date = ?`,
    args: [yyyymmdd],
  });
  for (const row of exceptionsResult.rows) {
    const serviceId = Number(row.service_id);
    if (Number(row.exception_type) === 1) active.add(serviceId);
    else active.delete(serviceId);
  }

  return [...active];
}

// #33 — a live prediction and its scheduled counterpart are the same trip only
// if their times sit within this window; a nearest scheduled departure further
// out than this is treated as "no schedule to compare against" and
// `delay_seconds` is omitted rather than reporting a bogus multi-hour delay.
const DELAY_MATCH_WINDOW_SECONDS = 2 * 60 * 60;

/**
 * `delay_seconds` for a live arrival: predicted − the nearest scheduled
 * departure of the same route at the same stop (positive = late). The queried
 * `stopId` is a single physical stop/platform, which one direction serves, so
 * "nearest scheduled departure of this route here" already isolates the right
 * scheduled trip without needing the (RT-unavailable) trip identity. Searches
 * the prediction's service date ±1 day to cover post-midnight GTFS times.
 * Returns `undefined` when nothing scheduled is within
 * `DELAY_MATCH_WINDOW_SECONDS` — the caller then omits `delay_seconds`.
 */
export async function scheduledDelaySeconds(
  client: Client,
  stopId: number,
  routeId: number,
  predictedEpochSeconds: number,
): Promise<number | undefined> {
  const predictedMs = predictedEpochSeconds * 1000;
  const today = serviceDateAt(new Date(predictedMs));
  let nearest: number | undefined;
  for (let offset = -1; offset <= 1; offset++) {
    const date = addDays(today, offset);
    const serviceIds = await activeServiceIds(client, date);
    if (serviceIds.length === 0) continue;
    const placeholders = serviceIds.map(() => "?").join(", ");
    const result = await client.execute({
      sql: `SELECT st.dep AS dep
            FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id
            WHERE st.stop_id = ? AND t.route_id = ?
              AND t.service_id IN (${placeholders}) AND st.dep IS NOT NULL`,
      args: [stopId, routeId, ...serviceIds],
    });
    for (const row of result.rows) {
      const absMs = absoluteTimeFor(date, Number(row.dep)).getTime();
      const diff = Math.round((predictedMs - absMs) / 1000);
      if (nearest === undefined || Math.abs(diff) < Math.abs(nearest)) {
        nearest = diff;
      }
    }
  }
  if (nearest === undefined || Math.abs(nearest) > DELAY_MATCH_WINDOW_SECONDS) {
    return undefined;
  }
  return nearest;
}

interface RawDeparture {
  stop_id: number;
  dep: number;
  route_id: number;
  route_short_name: string | null;
  trip_headsign: string | null;
  direction_id: number | null;
}

async function fetchDepartureRows(
  client: Client,
  stopIds: number[],
  serviceIds: number[],
  routeId: number | undefined,
  minDep: number,
  limit: number,
): Promise<RawDeparture[]> {
  if (stopIds.length === 0 || serviceIds.length === 0) return [];
  const stopPlaceholders = stopIds.map(() => "?").join(", ");
  const servicePlaceholders = serviceIds.map(() => "?").join(", ");
  const routeFilter = routeId !== undefined ? "AND t.route_id = ?" : "";
  const result = await client.execute({
    sql: `SELECT st.stop_id AS stop_id, st.dep AS dep, t.route_id AS route_id,
                 t.trip_headsign AS trip_headsign, t.direction_id AS direction_id,
                 r.route_short_name AS route_short_name
          FROM stop_times st
          JOIN trips t ON t.trip_id = st.trip_id
          JOIN routes r ON r.route_id = t.route_id
          WHERE st.stop_id IN (${stopPlaceholders})
            AND t.service_id IN (${servicePlaceholders})
            AND st.dep IS NOT NULL
            AND st.dep >= ?
            ${routeFilter}
          ORDER BY st.dep
          LIMIT ?`,
    args: [
      ...stopIds,
      ...serviceIds,
      minDep,
      ...(routeId !== undefined ? [routeId] : []),
      limit,
    ],
  });
  return result.rows.map((row) => ({
    stop_id: Number(row.stop_id),
    dep: Number(row.dep),
    route_id: Number(row.route_id),
    route_short_name:
      row.route_short_name === null ? null : asText(row.route_short_name),
    trip_headsign:
      row.trip_headsign === null ? null : asText(row.trip_headsign),
    direction_id: row.direction_id === null ? null : Number(row.direction_id),
  }));
}

function toScheduledDeparture(
  row: RawDeparture,
  absolute: Date,
  platformStopId: string | undefined,
): ScheduledDeparture {
  const shortName = presence(row.route_short_name);
  return {
    route_id: String(row.route_id),
    ...(shortName !== undefined ? { route_short_name: shortName } : {}),
    // GTFS occasionally leaves trip_headsign blank; degrade to "" rather
    // than drop the departure (never-drop is the project's stated posture
    // for imperfect upstream data — see docs/spec/realtime-integration.md).
    headsign: row.trip_headsign ?? "",
    direction_id: row.direction_id ?? 0,
    scheduled_time: toIsoWithTorontoOffset(absolute),
    ...(platformStopId !== undefined
      ? { platform_stop_id: platformStopId }
      : {}),
  };
}

export function toStopSummary(detail: StopDetail): StopSummary {
  return {
    stop_id: detail.stop_id,
    ...(detail.stop_code !== undefined ? { stop_code: detail.stop_code } : {}),
    name: detail.name,
    mode: detail.mode,
    is_station: detail.is_station,
    ...(detail.parent_station !== undefined
      ? { parent_station: detail.parent_station }
      : {}),
    lat: detail.lat,
    lon: detail.lon,
    ...(detail.accessible !== undefined
      ? { accessible: detail.accessible }
      : {}),
  };
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
// The base next-N search window around `when`'s service date: covers a
// GTFS-encoded post-midnight trip belonging to yesterday's service_id, and
// tomorrow's first trips when nothing is left to run tonight.
const BACKWARD_DAY_OFFSET = -1;
const BASE_FORWARD_DAY_OFFSET = 1;
// If the base window has zero active service at all — e.g. a GTFS
// board-period transition (or an upstream publishing outage) that leaves a
// multi-day gap with no calendar coverage — keep looking forward up to this
// many days so "next departures" doesn't go silent during the gap. Bounded
// to keep the pathological case (a stop with no service at all) cheap.
const MAX_LOOKAHEAD_DAYS = 14;

export interface GetScheduleParams {
  stopId: number;
  routeId?: number;
  when?: Date;
  limit?: number;
}

export interface GetScheduleResult {
  stop: StopSummary;
  departures: ScheduledDeparture[];
  truncated: boolean;
  hint?: string;
}

/** Next-N scheduled departures at a stop (or, for a station, aggregated
 * across its child platforms), from `when` onward. Searches a base +/-1-day
 * window first; if that window has no active service at all, extends the
 * search forward (bounded by `MAX_LOOKAHEAD_DAYS`) so a multi-day calendar
 * gap doesn't silently produce an empty result. */
export async function getSchedule(
  client: Client,
  params: GetScheduleParams,
): Promise<GetScheduleResult | undefined> {
  const stopDetail = await getStopById(client, params.stopId);
  if (!stopDetail) return undefined;

  const platformIds = stopDetail.is_station
    ? (stopDetail.platforms ?? []).map((p) => Number(p.stop_id))
    : [params.stopId];

  const stop = toStopSummary(stopDetail);
  if (platformIds.length === 0) {
    return { stop, departures: [], truncated: false };
  }

  const when = params.when ?? new Date();
  const today = serviceDateAt(when);
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // Matches found within the base [-1, +1] window, tracked separately from
  // the extended lookahead below — this is what distinguishes "there was a
  // real multi-day service gap" from "this is just a low-frequency stop and
  // we kept reading extra days to fill the requested page size".
  let baseWindowMatchCount = 0;
  const withAbsolute: { row: RawDeparture; absolute: Date }[] = [];
  for (
    let offset = BACKWARD_DAY_OFFSET;
    offset <= MAX_LOOKAHEAD_DAYS;
    offset++
  ) {
    const date = addDays(today, offset);
    const serviceIds = await activeServiceIds(client, date);
    if (serviceIds.length > 0) {
      // Only the earliest `limit + 1` departures at/after `when` for this day
      // — a windowed indexed fetch, not a blind cap that could chop off the
      // rest of a busy stop's day. The `+ 1` lets the merged result detect
      // truncation accurately.
      const minDep = Math.max(0, secondsSinceServiceMidnight(date, when));
      const rows = await fetchDepartureRows(
        client,
        platformIds,
        serviceIds,
        params.routeId,
        minDep,
        limit + 1,
      );
      for (const row of rows) {
        const absolute = absoluteTimeFor(date, row.dep);
        if (absolute.getTime() >= when.getTime()) {
          withAbsolute.push({ row, absolute });
          if (offset <= BASE_FORWARD_DAY_OFFSET) baseWindowMatchCount++;
        }
      }
    }
    // Once the base window is fully evaluated, stop as soon as there's
    // enough to fill the page — no need to keep reading further-out days.
    if (offset >= BASE_FORWARD_DAY_OFFSET && withAbsolute.length > limit) {
      break;
    }
  }
  withAbsolute.sort((a, b) => a.absolute.getTime() - b.absolute.getTime());

  const truncated = withAbsolute.length > limit;
  const departures = withAbsolute
    .slice(0, limit)
    .map(({ row, absolute }) =>
      toScheduledDeparture(
        row,
        absolute,
        stopDetail.is_station ? String(row.stop_id) : undefined,
      ),
    );

  const hintParts: string[] = [];
  if (baseWindowMatchCount === 0) {
    hintParts.push(
      departures.length > 0
        ? "No scheduled service found in the next day from `when`; showing the next available service day (the ingested GTFS calendar may have a gap — see docs/spec/gtfs-ingestion.md's refresh model)."
        : `No scheduled service found in the next ${String(MAX_LOOKAHEAD_DAYS)} days.`,
    );
  }
  if (truncated && params.routeId === undefined) {
    hintParts.push("Narrow with route_id to see fewer results.");
  }

  return {
    stop,
    departures,
    truncated,
    ...(hintParts.length > 0 ? { hint: hintParts.join(" ") } : {}),
  };
}
