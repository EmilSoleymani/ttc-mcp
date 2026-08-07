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

export interface FixtureStopTimeUpdate {
  stopId: string;
  /** Predicted arrival epoch seconds (falls back to `departure` per spec). */
  arrivalSeconds?: number;
  departureSeconds?: number;
  /** GTFS-RT StopTimeUpdate.ScheduleRelationship (SCHEDULED=0, SKIPPED=1,
   * NO_DATA=2, UNSCHEDULED=3); omitted → the proto default (SCHEDULED). */
  scheduleRelationship?: transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship;
}

export interface FixtureTripUpdate {
  tripId?: string;
  routeId?: string;
  stopTimeUpdates?: FixtureStopTimeUpdate[];
}

/** Encodes a captured-shape TripUpdates FeedMessage (protobuf bytes), the
 * wire format `bustime.ttc.ca/gtfsrt/trips` serves, for use as a fake `fetch`
 * body in tests (mirrors `encodeVehiclePositionsFeed`). */
export function encodeTripUpdatesFeed(
  tripUpdates: FixtureTripUpdate[],
): Uint8Array {
  const message = GtfsRt.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: GtfsRt.FeedHeader.Incrementality.FULL_DATASET,
      timestamp: Math.floor(Date.now() / 1000),
    },
    entity: tripUpdates.map((t, i) => ({
      id: `entity-${String(i)}`,
      tripUpdate: {
        // `trip` is a required field on TripUpdate (unlike the optional
        // `trip` on VehiclePosition) — always emit a descriptor, even when
        // both ids are absent.
        trip: { routeId: t.routeId ?? null, tripId: t.tripId ?? null },
        stopTimeUpdate: (t.stopTimeUpdates ?? []).map((stu) => ({
          stopId: stu.stopId,
          arrival:
            stu.arrivalSeconds !== undefined
              ? { time: stu.arrivalSeconds }
              : null,
          departure:
            stu.departureSeconds !== undefined
              ? { time: stu.departureSeconds }
              : null,
          scheduleRelationship: stu.scheduleRelationship ?? null,
        })),
      },
    })),
  });
  return GtfsRt.FeedMessage.encode(message).finish();
}

/** An RtClient whose `trips` feed fetch resolves to the given fixture trip
 * updates, encoded on the fly — no network access. */
export function fixtureTripUpdatesRtClient(
  tripUpdates: FixtureTripUpdate[],
  options: RtClientOptions = {},
): RtClient {
  const body = encodeTripUpdatesFeed(tripUpdates);
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
