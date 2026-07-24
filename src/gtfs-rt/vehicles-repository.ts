import { transit_realtime } from "gtfs-realtime-bindings";
import type Long from "long";

import type { Vehicle } from "../schemas/vehicle.js";

const TORONTO_TZ = "America/Toronto";

// The runtime enum protobufjs generates is a plain object with both the
// forward (name -> number) and reverse (number -> name) mapping, so this
// indexes straight into it rather than hand-maintaining a parallel table.
const OCCUPANCY_STATUS_NAMES = transit_realtime.VehiclePosition
  .OccupancyStatus as unknown as Record<number, string>;

function occupancyStatusName(
  status: transit_realtime.VehiclePosition.OccupancyStatus | null | undefined,
): string | undefined {
  if (status === null || status === undefined) return undefined;
  const name = OCCUPANCY_STATUS_NAMES[status];
  return name?.toLowerCase();
}

function toEpochSeconds(value: number | Long | null | undefined): number {
  if (value === null || value === undefined)
    return Math.floor(Date.now() / 1000);
  return typeof value === "number" ? value : value.toNumber();
}

function torontoOffset(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TORONTO_TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(tzName);
  if (!match) return "+00:00";
  const [, sign, hours, minutes] = match;
  return `${sign}${(hours ?? "0").padStart(2, "0")}:${(minutes ?? "00").padStart(2, "0")}`;
}

/** Epoch seconds -> absolute ISO 8601 with the America/Toronto offset
 * (docs/spec/tool-schemas.md "Conventions"). */
export function toTorontoIso(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TORONTO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${torontoOffset(date)}`;
}

/**
 * Decoded VehiclePosition -> Vehicle DTO for a specific route_id. Returns
 * `undefined` for a deadheading/unassigned vehicle (empty/missing
 * `trip.routeId`) or one belonging to a different route
 * (docs/spec/realtime-integration.md #3 "VehiclePositions -> get_vehicles").
 */
export function toVehicle(
  position: transit_realtime.IVehiclePosition,
  routeId: string,
): Vehicle | undefined {
  const positionRouteId = position.trip?.routeId;
  if (!positionRouteId || positionRouteId !== routeId) return undefined;

  const vehicleId = position.vehicle?.id;
  const lat = position.position?.latitude;
  const lon = position.position?.longitude;
  if (!vehicleId || lat === undefined || lon === undefined) return undefined;

  const bearing = position.position?.bearing;
  const tripId = position.trip?.tripId;
  const occupancyStatus = occupancyStatusName(position.occupancyStatus);

  return {
    vehicle_id: vehicleId,
    lat,
    lon,
    ...(bearing !== null && bearing !== undefined ? { bearing } : {}),
    route_id: positionRouteId,
    ...(tripId ? { trip_id: tripId } : {}),
    ...(occupancyStatus !== undefined
      ? { occupancy_status: occupancyStatus }
      : {}),
    timestamp: toTorontoIso(toEpochSeconds(position.timestamp)),
  };
}

/** All vehicles on `routeId` from a decoded VehiclePositions feed. */
export function vehiclesForRoute(
  positions: transit_realtime.IVehiclePosition[],
  routeId: string,
): Vehicle[] {
  const vehicles: Vehicle[] = [];
  for (const position of positions) {
    const vehicle = toVehicle(position, routeId);
    if (vehicle) vehicles.push(vehicle);
  }
  return vehicles;
}
