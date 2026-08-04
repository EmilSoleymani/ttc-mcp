import type { Client } from "@libsql/client";

import { type ToolError, toolError } from "../../errors.js";
import type { Candidates, Endpoint } from "../../schemas/itinerary.js";
import type { StopSummary } from "../../schemas/stop.js";
import { toStopSummary as summaryFromDetail } from "../schedule-repository.js";
import {
  getStopById,
  haversineMeters,
  searchStopsByName,
  searchStopsNear,
} from "../stops-repository.js";
import { fetchFootpaths } from "./queries.js";

// Endpoint resolution and access-stop expansion for plan_trip
// (docs/superpowers/specs/2026-08-04-plan-trip-design.md §"Endpoint resolution",
// ADR 0002). The ladder itself is PR2.

const ACCESS_RADIUS_M = 250;
const ACCESS_FANOUT = 8;
const WALK_SPEED_MPS = 1.3;

/** A stop reachable at the start/end of a trip, with the walk to reach it. */
export interface AccessStop {
  stop: StopSummary;
  walk_seconds: number;
}

/** A resolved endpoint, normalised to how its access stops are found. */
export type AccessPoint = { stop_id: number } | { lat: number; lon: number };

function walkSecondsFor(meters: number): number {
  return Math.round(meters / WALK_SPEED_MPS);
}

/**
 * The access stops for a resolved endpoint: for a stop, itself (walk 0) plus
 * its footpath neighbours; for a coordinate, the nearest stops within
 * `ACCESS_RADIUS_M`, capped at `ACCESS_FANOUT`, walk = haversine ÷ 1.3 m/s.
 */
export async function accessStops(
  client: Client,
  point: AccessPoint,
): Promise<AccessStop[]> {
  if ("lat" in point) {
    const near = await searchStopsNear(
      client,
      point.lat,
      point.lon,
      ACCESS_RADIUS_M,
      {
        limit: ACCESS_FANOUT,
      },
    );
    return near.stops.map((stop) => ({
      stop,
      walk_seconds: walkSecondsFor(
        haversineMeters(point.lat, point.lon, stop.lat, stop.lon),
      ),
    }));
  }

  const detail = await getStopById(client, point.stop_id);
  if (!detail) return [];
  const access: AccessStop[] = [
    { stop: summaryFromDetail(detail), walk_seconds: 0 },
  ];

  const footpaths = await fetchFootpaths(client, [point.stop_id]);
  // Keep the cheapest walk when several footpaths reach the same neighbour.
  const cheapest = new Map<number, number>();
  for (const fp of footpaths) {
    const prev = cheapest.get(fp.to_stop_id);
    if (prev === undefined || fp.min_walk_seconds < prev) {
      cheapest.set(fp.to_stop_id, fp.min_walk_seconds);
    }
  }
  for (const [neighbourId, walk] of cheapest) {
    const neighbour = await getStopById(client, neighbourId);
    if (neighbour) {
      access.push({ stop: summaryFromDetail(neighbour), walk_seconds: walk });
    }
  }
  return access;
}

export type Resolution =
  | { kind: "resolved"; stop: StopSummary; access: AccessPoint }
  | { kind: "ambiguous"; matches: StopSummary[] }
  | { kind: "not_found"; message: string };

/**
 * Resolve one endpoint. A `stop_id` (all-digits string) that is unknown →
 * `not_found`; a place name resolving to >1 stop → `ambiguous` (candidates,
 * success-shaped); a coordinate always resolves to its nearest stop (or
 * `not_found` if nothing is within range).
 */
export async function resolveEndpoint(
  client: Client,
  value: Endpoint,
): Promise<Resolution> {
  if (typeof value !== "string") {
    const access = await accessStops(client, {
      lat: value.lat,
      lon: value.lon,
    });
    const nearest = access[0];
    if (!nearest) {
      return { kind: "not_found", message: "no stops near that location" };
    }
    return { kind: "resolved", stop: nearest.stop, access: value };
  }

  if (/^\d+$/.test(value)) {
    const stopId = Number(value);
    const detail = await getStopById(client, stopId);
    if (!detail)
      return { kind: "not_found", message: `unknown stop_id ${value}` };
    return {
      kind: "resolved",
      stop: summaryFromDetail(detail),
      access: { stop_id: stopId },
    };
  }

  const { stops } = await searchStopsByName(client, value);
  if (stops.length > 1) return { kind: "ambiguous", matches: stops };
  const only = stops[0];
  if (!only)
    return { kind: "not_found", message: `no stop matches "${value}"` };
  return {
    kind: "resolved",
    stop: only,
    access: { stop_id: Number(only.stop_id) },
  };
}

export type BothResolution =
  | {
      kind: "ok";
      from: StopSummary;
      to: StopSummary;
      fromAccess: AccessPoint;
      toAccess: AccessPoint;
    }
  | { kind: "candidates"; candidates: Candidates }
  | { kind: "error"; error: ToolError };

/** Resolve both endpoints, reporting `from` ambiguity/failure before `to`. */
export async function resolveBothEndpoints(
  client: Client,
  from: Endpoint,
  to: Endpoint,
): Promise<BothResolution> {
  const rf = await resolveEndpoint(client, from);
  if (rf.kind === "ambiguous") {
    return {
      kind: "candidates",
      candidates: { endpoint: "from", matches: rf.matches },
    };
  }
  if (rf.kind === "not_found") {
    return {
      kind: "error",
      error: toolError("not_found", `from: ${rf.message}`),
    };
  }

  const rt = await resolveEndpoint(client, to);
  if (rt.kind === "ambiguous") {
    return {
      kind: "candidates",
      candidates: { endpoint: "to", matches: rt.matches },
    };
  }
  if (rt.kind === "not_found") {
    return {
      kind: "error",
      error: toolError("not_found", `to: ${rt.message}`),
    };
  }

  return {
    kind: "ok",
    from: rf.stop,
    to: rt.stop,
    fromAccess: rf.access,
    toAccess: rt.access,
  };
}
