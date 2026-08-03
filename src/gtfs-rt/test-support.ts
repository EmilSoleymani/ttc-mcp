// See rt-client.ts for why this goes through the default export.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime } from "gtfs-realtime-bindings";

import { RtClient, type RtClientOptions } from "./rt-client.js";

const { transit_realtime: GtfsRt } = GtfsRealtimeBindings;

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
  const message = GtfsRt.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: GtfsRt.FeedHeader.Incrementality.FULL_DATASET,
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
  return GtfsRt.FeedMessage.encode(message).finish();
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

export interface FixtureAlertEntity {
  routeId?: string;
  stopId?: string;
  routeType?: number;
}

export interface FixtureAlertPeriod {
  start?: number;
  end?: number;
}

export interface FixtureAlert {
  id: string;
  headerText?: string;
  descriptionText?: string;
  cause?: transit_realtime.Alert.Cause;
  effect?: transit_realtime.Alert.Effect;
  severityLevel?: transit_realtime.Alert.SeverityLevel;
  informedEntity?: FixtureAlertEntity[];
  activePeriod?: FixtureAlertPeriod[];
  url?: string;
}

/** Encodes a captured-shape Alerts FeedMessage (protobuf bytes), the same
 * wire format the real `bustime.ttc.ca/gtfsrt/alerts` feed serves, for use as
 * a fake `fetch` response body in tests. */
export function encodeAlertsFeed(alerts: FixtureAlert[]): Uint8Array {
  const message = GtfsRt.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: GtfsRt.FeedHeader.Incrementality.FULL_DATASET,
      timestamp: Math.floor(Date.now() / 1000),
    },
    entity: alerts.map((a) => ({
      id: a.id,
      alert: {
        cause: a.cause ?? null,
        effect: a.effect ?? null,
        severityLevel: a.severityLevel ?? null,
        headerText:
          a.headerText !== undefined
            ? { translation: [{ text: a.headerText, language: "en" }] }
            : null,
        descriptionText:
          a.descriptionText !== undefined
            ? { translation: [{ text: a.descriptionText, language: "en" }] }
            : null,
        url:
          a.url !== undefined
            ? { translation: [{ text: a.url, language: "en" }] }
            : null,
        informedEntity: (a.informedEntity ?? []).map((e) => ({
          routeId: e.routeId ?? null,
          stopId: e.stopId ?? null,
          routeType: e.routeType ?? null,
        })),
        activePeriod: (a.activePeriod ?? []).map((p) => ({
          start: p.start ?? null,
          end: p.end ?? null,
        })),
      },
    })),
  });
  return GtfsRt.FeedMessage.encode(message).finish();
}

/** An RtClient whose `alerts` feed fetch resolves to the given fixture
 * alerts, encoded on the fly — no network access. */
export function fixtureAlertsRtClient(
  alerts: FixtureAlert[],
  options: RtClientOptions = {},
): RtClient {
  const body = encodeAlertsFeed(alerts);
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
