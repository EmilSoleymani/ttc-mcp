import type { Client } from "@libsql/client";

import type { ScheduledDeparture } from "../schemas/schedule.js";
import type { StopDetail, StopSummary } from "../schemas/stop.js";
import {
  addDays,
  absoluteTimeFor,
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
 * `calendar_dates` add/remove exceptions for that date. */
async function activeServiceIds(
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

interface RawDeparture {
  stop_id: number;
  dep: number;
  route_id: number;
  route_short_name: string | null;
  trip_headsign: string | null;
  direction_id: number | null;
}

// Per-(stop set, service date) cap on fetched rows, well above any real
// stop's daily departure count — the anti-dump cap is applied after
// merging + sorting across candidate dates, not here.
const CANDIDATE_CEILING = 500;

async function fetchDepartureRows(
  client: Client,
  stopIds: number[],
  serviceIds: number[],
  routeId: number | undefined,
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
            ${routeFilter}
          LIMIT ${String(CANDIDATE_CEILING)}`,
    args: [
      ...stopIds,
      ...serviceIds,
      ...(routeId !== undefined ? [routeId] : []),
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

function toStopSummaryOnly(detail: StopDetail): StopSummary {
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
// The next-N search window around `when`'s service date: covers a
// GTFS-encoded post-midnight trip belonging to yesterday's service_id, and
// tomorrow's first trips when nothing is left to run tonight.
const CANDIDATE_DAY_OFFSETS = [-1, 0, 1];

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
 * across its child platforms), from `when` onward. */
export async function getSchedule(
  client: Client,
  params: GetScheduleParams,
): Promise<GetScheduleResult | undefined> {
  const stopDetail = await getStopById(client, params.stopId);
  if (!stopDetail) return undefined;

  const platformIds = stopDetail.is_station
    ? (stopDetail.platforms ?? []).map((p) => Number(p.stop_id))
    : [params.stopId];

  const stop = toStopSummaryOnly(stopDetail);
  if (platformIds.length === 0) {
    return { stop, departures: [], truncated: false };
  }

  const when = params.when ?? new Date();
  const today = serviceDateAt(when);

  const withAbsolute: { row: RawDeparture; absolute: Date }[] = [];
  for (const offset of CANDIDATE_DAY_OFFSETS) {
    const date = addDays(today, offset);
    const serviceIds = await activeServiceIds(client, date);
    if (serviceIds.length === 0) continue;
    const rows = await fetchDepartureRows(
      client,
      platformIds,
      serviceIds,
      params.routeId,
    );
    for (const row of rows) {
      const absolute = absoluteTimeFor(date, row.dep);
      if (absolute.getTime() >= when.getTime()) {
        withAbsolute.push({ row, absolute });
      }
    }
  }
  withAbsolute.sort((a, b) => a.absolute.getTime() - b.absolute.getTime());

  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
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

  return {
    stop,
    departures,
    truncated,
    ...(truncated && params.routeId === undefined
      ? { hint: "Narrow with route_id to see fewer results." }
      : {}),
  };
}
