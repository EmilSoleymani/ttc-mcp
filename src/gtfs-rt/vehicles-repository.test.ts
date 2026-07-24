// See rt-client.ts for why this goes through the default export.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { describe, expect, it } from "vitest";

import {
  toTorontoIso,
  toVehicle,
  vehiclesForRoute,
} from "./vehicles-repository.js";

const { transit_realtime } = GtfsRealtimeBindings;

describe("toTorontoIso", () => {
  it("formats a summer (EDT) timestamp with a -04:00 offset", () => {
    // 2026-07-24T18:00:00Z is 14:00 EDT.
    const epoch = Date.UTC(2026, 6, 24, 18, 0, 0) / 1000;
    expect(toTorontoIso(epoch)).toBe("2026-07-24T14:00:00-04:00");
  });

  it("formats a winter (EST) timestamp with a -05:00 offset", () => {
    // 2026-01-15T18:00:00Z is 13:00 EST.
    const epoch = Date.UTC(2026, 0, 15, 18, 0, 0) / 1000;
    expect(toTorontoIso(epoch)).toBe("2026-01-15T13:00:00-05:00");
  });
});

describe("toVehicle", () => {
  it("maps a decoded VehiclePosition to the Vehicle DTO", () => {
    const epoch = Date.UTC(2026, 6, 24, 18, 0, 0) / 1000;
    const position = transit_realtime.VehiclePosition.create({
      vehicle: { id: "8001" },
      trip: { routeId: "504", tripId: "trip-1" },
      position: { latitude: 43.6, longitude: -79.4, bearing: 90 },
      occupancyStatus:
        transit_realtime.VehiclePosition.OccupancyStatus.FEW_SEATS_AVAILABLE,
      timestamp: epoch,
    });

    const vehicle = toVehicle(position, "504");
    expect(vehicle).toEqual({
      vehicle_id: "8001",
      lat: 43.6,
      lon: -79.4,
      bearing: 90,
      route_id: "504",
      trip_id: "trip-1",
      occupancy_status: "few_seats_available",
      timestamp: "2026-07-24T14:00:00-04:00",
    });
  });

  it("returns undefined for a deadheading vehicle (empty route_id)", () => {
    const position = transit_realtime.VehiclePosition.create({
      vehicle: { id: "8002" },
      trip: { routeId: "" },
      position: { latitude: 43.6, longitude: -79.4 },
    });
    expect(toVehicle(position, "504")).toBeUndefined();
  });

  it("returns undefined for a vehicle with no trip assignment at all", () => {
    const position = transit_realtime.VehiclePosition.create({
      vehicle: { id: "8003" },
      position: { latitude: 43.6, longitude: -79.4 },
    });
    expect(toVehicle(position, "504")).toBeUndefined();
  });

  it("returns undefined for a vehicle on a different route", () => {
    const position = transit_realtime.VehiclePosition.create({
      vehicle: { id: "8004" },
      trip: { routeId: "505" },
      position: { latitude: 43.6, longitude: -79.4 },
    });
    expect(toVehicle(position, "504")).toBeUndefined();
  });
});

describe("vehiclesForRoute", () => {
  it("filters a mixed feed down to the requested route, dropping deadheads", () => {
    const positions = [
      transit_realtime.VehiclePosition.create({
        vehicle: { id: "8001" },
        trip: { routeId: "504" },
        position: { latitude: 43.6, longitude: -79.4 },
      }),
      transit_realtime.VehiclePosition.create({
        vehicle: { id: "8002" },
        trip: { routeId: "" },
        position: { latitude: 43.6, longitude: -79.4 },
      }),
      transit_realtime.VehiclePosition.create({
        vehicle: { id: "8003" },
        trip: { routeId: "505" },
        position: { latitude: 43.6, longitude: -79.4 },
      }),
    ];

    const vehicles = vehiclesForRoute(positions, "504");
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0]?.vehicle_id).toBe("8001");
  });
});
