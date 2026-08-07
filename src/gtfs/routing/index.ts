import type { Client } from "@libsql/client";

import { type ToolError, toolError } from "../../errors.js";
import type {
  Candidates,
  Endpoint,
  Itinerary,
} from "../../schemas/itinerary.js";
import type { Mode, StopSummary } from "../../schemas/stop.js";
import { toStopSummary as summaryFromDetail } from "../schedule-repository.js";
import {
  getStopById,
  haversineMeters,
  searchStopsByName,
  searchStopsNear,
} from "../stops-repository.js";
import { runLadder } from "./ladder.js";
import { fetchFootpaths } from "./queries.js";
import { reconstructItinerary } from "./reconstruct.js";

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

  // A station (parent) carries no stop_times — trips reference its child
  // platforms. Board from the platforms (walk 0, you're already at the
  // station); a plain stop boards from itself.
  const platforms = detail.is_station ? (detail.platforms ?? []) : [];
  const access: AccessStop[] =
    platforms.length > 0
      ? platforms.map((stop) => ({ stop, walk_seconds: 0 }))
      : [{ stop: summaryFromDetail(detail), walk_seconds: 0 }];

  // Footpaths radiate from the actual boardable stops (the platforms for a
  // station, else the stop itself).
  const originIds = access.map((a) => Number(a.stop.stop_id));
  const alreadyAccess = new Set(originIds);
  const footpaths = await fetchFootpaths(client, originIds);
  // Keep the cheapest walk when several footpaths reach the same neighbour;
  // skip neighbours already boardable (e.g. a sibling platform).
  const cheapest = new Map<number, number>();
  for (const fp of footpaths) {
    if (alreadyAccess.has(fp.to_stop_id)) continue;
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

export interface PlanDepartAfterParams {
  from: StopSummary;
  to: StopSummary;
  fromAccess: AccessPoint;
  toAccess: AccessPoint;
  depart: Date;
  maxTransfers: number;
  modes?: readonly Mode[];
}

/**
 * The depart-after plan for one earliest-arrival itinerary: expand both
 * endpoints to access stops, run the ladder, and reconstruct. Returns
 * undefined when the destination is unreachable within the search bounds.
 * (arrive_by, alternates, and ranking are a later slice.)
 */
export async function planDepartAfter(
  client: Client,
  params: PlanDepartAfterParams,
): Promise<Itinerary | undefined> {
  const originAccess = await accessStops(client, params.fromAccess);
  const destAccess = await accessStops(client, params.toAccess);
  const departMs = params.depart.getTime();

  const best = await runLadder(client, {
    originAccess: originAccess.map((a) => ({
      stopId: Number(a.stop.stop_id),
      walk: a.walk_seconds,
    })),
    departMs,
    maxTransfers: params.maxTransfers,
    ...(params.modes !== undefined ? { modes: params.modes } : {}),
  });

  return reconstructItinerary(client, best, {
    from: params.from,
    to: params.to,
    destAccess: destAccess.map((a) => ({
      stopId: Number(a.stop.stop_id),
      walk: a.walk_seconds,
    })),
    departMs,
  });
}
