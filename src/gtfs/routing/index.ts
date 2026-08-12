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
import { MAX_HORIZON_SECONDS, type OriginAccess, runLadder } from "./ladder.js";
import { fetchFootpaths } from "./queries.js";
import {
  dedupeBySignature,
  routeSignature,
  sortByArrival,
  sortByLatestDeparture,
} from "./rank.js";
import { reconstructItinerary } from "./reconstruct.js";

// arrive_by is emulated: solve an anchor for the fastest travel time, then
// probe depart-after from ~target − Δ − slack and push the departure later
// while arrivals stay within the target. The slack absorbs the anchor's Δ
// estimate error.
const ARRIVE_BY_SLACK_SECONDS = 20 * 60;

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

export interface PlanEndpoints {
  from: StopSummary;
  to: StopSummary;
  fromAccess: AccessPoint;
  toAccess: AccessPoint;
  maxTransfers: number;
  modes?: readonly Mode[];
}

// Everything a single solve needs, with the access-stop expansion done once so
// the alternates / arrive_by loops can re-solve at shifted departures cheaply.
interface SolveContext {
  from: StopSummary;
  to: StopSummary;
  originAccess: OriginAccess[];
  destAccess: OriginAccess[];
  maxTransfers: number;
  modes?: readonly Mode[];
}

async function buildSolveContext(
  client: Client,
  endpoints: PlanEndpoints,
): Promise<SolveContext> {
  const toOriginAccess = (stops: Awaited<ReturnType<typeof accessStops>>) =>
    stops.map((a) => ({
      stopId: Number(a.stop.stop_id),
      walk: a.walk_seconds,
    }));
  return {
    from: endpoints.from,
    to: endpoints.to,
    originAccess: toOriginAccess(
      await accessStops(client, endpoints.fromAccess),
    ),
    destAccess: toOriginAccess(await accessStops(client, endpoints.toAccess)),
    maxTransfers: endpoints.maxTransfers,
    ...(endpoints.modes !== undefined ? { modes: endpoints.modes } : {}),
  };
}

/** One earliest-arrival solve at `departMs`: run the ladder, reconstruct. */
async function solveDepartAfter(
  client: Client,
  ctx: SolveContext,
  departMs: number,
): Promise<Itinerary | undefined> {
  const best = await runLadder(client, {
    originAccess: ctx.originAccess,
    targetAccess: ctx.destAccess,
    departMs,
    maxTransfers: ctx.maxTransfers,
    ...(ctx.modes !== undefined ? { modes: ctx.modes } : {}),
  });
  return reconstructItinerary(client, best, {
    from: ctx.from,
    to: ctx.to,
    destAccess: ctx.destAccess,
    departMs,
  });
}

/** The absolute epoch ms the rider boards the first transit leg. */
function firstBoardMs(itinerary: Itinerary): number {
  for (const leg of itinerary.legs) {
    if (leg.type === "transit") return new Date(leg.board_time).getTime();
  }
  // reconstruction guarantees at least one transit leg.
  return new Date(itinerary.depart_time).getTime();
}

export interface PlanDepartAfterParams extends PlanEndpoints {
  depart: Date;
}

/**
 * The depart-after plan for one earliest-arrival itinerary. Retained for the
 * real-DB smoke and single-solve callers; `planTrip` is the full entry.
 */
export async function planDepartAfter(
  client: Client,
  params: PlanDepartAfterParams,
): Promise<Itinerary | undefined> {
  const ctx = await buildSolveContext(client, params);
  return solveDepartAfter(client, ctx, params.depart.getTime());
}

export interface PlanTripParams extends PlanEndpoints {
  when: Date;
  arriveBy: boolean;
  maxItineraries: number;
}

/**
 * Plan up to `maxItineraries` distinct itineraries. Depart-after: earliest
 * arrival plus alternates from shifted departures, deduped by route signature,
 * ranked by arrival. (arrive_by emulation is added in the next task.)
 */
export async function planTrip(
  client: Client,
  params: PlanTripParams,
): Promise<Itinerary[]> {
  const ctx = await buildSolveContext(client, params);
  if (params.arriveBy) {
    return planArriveBy(
      client,
      ctx,
      params.when.getTime(),
      params.maxItineraries,
    );
  }
  const collected = await collectShiftedForward(
    client,
    ctx,
    params.when.getTime(),
    params.maxItineraries,
  );
  return sortByArrival(collected).slice(0, params.maxItineraries);
}

/**
 * arrive_by emulation. Anchor-solve to learn the fastest travel time Δ (and
 * that the destination is reachable by the target at all), then scan
 * depart-after from ~target − Δ − slack, collecting itineraries that still
 * arrive by the target and pushing the departure later until they no longer
 * do. Ranked by latest departure; the early anchor is a last-resort fallback.
 */
async function planArriveBy(
  client: Client,
  ctx: SolveContext,
  targetMs: number,
  maxItineraries: number,
): Promise<Itinerary[]> {
  const anchor = await solveDepartAfter(
    client,
    ctx,
    targetMs - MAX_HORIZON_SECONDS * 1000,
  );
  // Unreachable, or nothing arrives by the target from within the horizon.
  if (!anchor || new Date(anchor.arrive_time).getTime() > targetMs) return [];

  const deltaMs = anchor.duration_seconds * 1000;
  const feasible: Itinerary[] = [];
  let departMs = targetMs - deltaMs - ARRIVE_BY_SLACK_SECONDS * 1000;

  const maxAttempts = 4 * maxItineraries + 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const itinerary = await solveDepartAfter(client, ctx, departMs);
    if (!itinerary) break;
    const arriveMs = new Date(itinerary.arrive_time).getTime();
    if (arriveMs <= targetMs) {
      feasible.push(itinerary);
    } else {
      // Later departures only arrive later — the boundary is passed.
      break;
    }
    const next = firstBoardMs(itinerary) + 1000;
    departMs = next > departMs ? next : departMs + 60_000;
  }

  // The anchor is feasible (checked above); fall back to it only if the probe
  // window found nothing (a Δ under-estimate).
  const ranked = dedupeBySignature(
    sortByLatestDeparture(feasible.length > 0 ? feasible : [anchor]),
  );
  return ranked.slice(0, maxItineraries);
}

/**
 * Solve depart-after repeatedly, each time shifting the departure to just after
 * the previous itinerary's first boarding, collecting distinct route
 * signatures until `count` are found or the attempt budget is spent.
 */
async function collectShiftedForward(
  client: Client,
  ctx: SolveContext,
  baseMs: number,
  count: number,
): Promise<Itinerary[]> {
  const out: Itinerary[] = [];
  const seen = new Set<string>();
  let departMs = baseMs;
  let consecutiveDupes = 0;
  const maxAttempts = 2 * count + 2;
  // On a single-corridor trip every shift returns the same route; stop after a
  // couple of repeats rather than burning the whole attempt budget re-solving.
  const maxConsecutiveDupes = 2;
  for (
    let attempt = 0;
    attempt < maxAttempts && out.length < count;
    attempt++
  ) {
    const itinerary = await solveDepartAfter(client, ctx, departMs);
    if (!itinerary) break;
    const sig = routeSignature(itinerary);
    if (seen.has(sig)) {
      if (++consecutiveDupes >= maxConsecutiveDupes) break;
    } else {
      seen.add(sig);
      out.push(itinerary);
      consecutiveDupes = 0;
    }
    // Advance past this itinerary's first departure so the next solve finds a
    // later option (guaranteed to make progress).
    const next = firstBoardMs(itinerary) + 1000;
    departMs = next > departMs ? next : departMs + 60_000;
  }
  return out;
}
