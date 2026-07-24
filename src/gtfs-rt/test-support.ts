import { transit_realtime } from "gtfs-realtime-bindings";

import { RtClient, type RtClientOptions } from "./rt-client.js";

/** An RtClient backed by a fake `fetchImpl`, for tests that don't exercise
 * live GTFS-RT data at all — caching disabled, any fetch call is a test bug. */
export function unusedRtClient(): RtClient {
  return new RtClient({
    cacheEnabled: false,
    fetchImpl: () =>
      Promise.reject(new Error("Unexpected GTFS-RT fetch in this test.")),
  });
}

export interface FixtureVehicle {
  vehicleId: string;
  routeId?: string;
  tripId?: string;
  lat: number;
  lon: number;
  bearing?: number;
  occupancyStatus?: transit_realtime.VehiclePosition.OccupancyStatus;
  timestampSeconds?: number;
}

/** Encodes a captured-shape VehiclePositions FeedMessage (protobuf bytes),
 * the same wire format the real `bustime.ttc.ca/gtfsrt/vehicles` feed
 * serves, for use as a fake `fetch` response body in tests. */
export function encodeVehiclePositionsFeed(
  vehicles: FixtureVehicle[],
): Uint8Array {
  const message = transit_realtime.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
      timestamp: Math.floor(Date.now() / 1000),
    },
    entity: vehicles.map((v, i) => ({
      id: `entity-${String(i)}`,
      vehicle: {
        vehicle: { id: v.vehicleId },
        position: {
          latitude: v.lat,
          longitude: v.lon,
          bearing: v.bearing ?? null,
        },
        trip:
          v.routeId !== undefined || v.tripId !== undefined
            ? { routeId: v.routeId ?? null, tripId: v.tripId ?? null }
            : null,
        occupancyStatus: v.occupancyStatus ?? null,
        timestamp: v.timestampSeconds ?? Math.floor(Date.now() / 1000),
      },
    })),
  });
  return transit_realtime.FeedMessage.encode(message).finish();
}

/** An RtClient whose `vehicles` feed fetch resolves to the given fixture
 * vehicles, encoded on the fly — no network access. */
export function fixtureVehiclesRtClient(
  vehicles: FixtureVehicle[],
  options: RtClientOptions = {},
): RtClient {
  const body = encodeVehiclePositionsFeed(vehicles);
  return new RtClient({
    cacheEnabled: false,
    fetchImpl: () =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-protobuf" },
        }),
      ),
    ...options,
  });
}
