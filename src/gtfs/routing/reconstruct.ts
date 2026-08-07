import type { Client } from "@libsql/client";

import type { Itinerary, Leg } from "../../schemas/itinerary.js";
import type { StopSummary } from "../../schemas/stop.js";
import { toStopSummary as summaryFromDetail } from "../schedule-repository.js";
import { getStopById } from "../stops-repository.js";
import { toIsoWithTorontoOffset } from "../service-time.js";
import type { Label, OriginAccess } from "./ladder.js";
import { fetchRouteMeta } from "./queries.js";

// Backtrack the ladder's parent pointers into an Itinerary
// (docs/superpowers/specs/2026-08-04-plan-trip-design.md §"Reconstruction").
// Pure of the ladder itself: given the best-label map and the endpoints, it
// picks the cheapest egress and walks the chain into transit + transfer legs.

export interface ReconstructParams {
  from: StopSummary;
  to: StopSummary;
  /** Destination access stops (the `to` stop + footpath/near neighbours). */
  destAccess: readonly OriginAccess[];
  departMs: number;
}

interface RawTransit {
  kind: "transit";
  boardId: number;
  alightId: number;
  boardTimeMs: number;
  alightTimeMs: number;
  routeId: number;
  headsign: string;
  numStops: number;
}
interface RawTransfer {
  kind: "transfer";
  fromId: number;
  toId: number;
  walkSeconds: number;
}
type RawLeg = RawTransit | RawTransfer;

/** Reconstruct the earliest-arrival itinerary to `to`, or undefined if no
 * destination access stop was reached (or the path has no transit leg). */
export async function reconstructItinerary(
  client: Client,
  best: ReadonlyMap<number, Label>,
  params: ReconstructParams,
): Promise<Itinerary | undefined> {
  const fromId = Number(params.from.stop_id);
  const toId = Number(params.to.stop_id);

  // Cheapest egress: earliest (arrival + egress walk) among reached access stops.
  let chosen: { stopId: number; walk: number; arriveMs: number } | undefined;
  for (const a of params.destAccess) {
    const label = best.get(a.stopId);
    if (!label) continue;
    const arriveMs = label.arrival + a.walk * 1000;
    if (!chosen || arriveMs < chosen.arriveMs) {
      chosen = { stopId: a.stopId, walk: a.walk, arriveMs };
    }
  }
  if (!chosen) return undefined;

  const reversed: RawLeg[] = [];
  if (chosen.stopId !== toId && chosen.walk > 0) {
    reversed.push({
      kind: "transfer",
      fromId: chosen.stopId,
      toId,
      walkSeconds: chosen.walk,
    });
  }

  let leadingWalk = 0;
  let currentId = chosen.stopId;
  // The chain is at most (maxTransfers+1) transit legs interleaved with
  // transfers; a generous guard prevents a malformed cycle from looping.
  for (let guard = 0; guard < 64; guard++) {
    const parent = best.get(currentId)?.parent;
    if (!parent) break;
    if (parent.via === "transit") {
      reversed.push({
        kind: "transit",
        boardId: parent.boardStopId,
        alightId: currentId,
        boardTimeMs: parent.boardTimeMs,
        alightTimeMs: best.get(currentId)!.arrival,
        routeId: parent.routeId,
        headsign: parent.headsign,
        numStops: parent.alightSeq - parent.boardSeq,
      });
      currentId = parent.boardStopId;
    } else if (parent.via === "transfer") {
      reversed.push({
        kind: "transfer",
        fromId: parent.fromStopId,
        toId: currentId,
        walkSeconds: parent.walkSeconds,
      });
      currentId = parent.fromStopId;
    } else {
      // Reached an origin access stop. Emit the leading walk only when it is a
      // real walk to a different stop than the reported origin.
      if (currentId !== fromId && parent.walkSeconds > 0) {
        reversed.push({
          kind: "transfer",
          fromId,
          toId: currentId,
          walkSeconds: parent.walkSeconds,
        });
        leadingWalk = parent.walkSeconds;
      }
      break;
    }
  }

  const rawLegs = reversed.reverse();
  const transits = rawLegs.filter((l): l is RawTransit => l.kind === "transit");
  if (transits.length === 0) return undefined;

  // Resolve the stop summaries and route metadata the legs reference.
  const summaries = new Map<number, StopSummary>([
    [fromId, params.from],
    [toId, params.to],
  ]);
  const neededStopIds = new Set<number>();
  for (const leg of rawLegs) {
    const ids =
      leg.kind === "transit"
        ? [leg.boardId, leg.alightId]
        : [leg.fromId, leg.toId];
    for (const id of ids) if (!summaries.has(id)) neededStopIds.add(id);
  }
  for (const id of neededStopIds) {
    const detail = await getStopById(client, id);
    if (!detail) return undefined;
    summaries.set(id, summaryFromDetail(detail));
  }
  const routeMeta = await fetchRouteMeta(client, [
    ...new Set(transits.map((t) => t.routeId)),
  ]);

  const legs: Leg[] = [];
  for (const raw of rawLegs) {
    if (raw.kind === "transit") {
      const meta = routeMeta.get(raw.routeId);
      const board = summaries.get(raw.boardId);
      const alight = summaries.get(raw.alightId);
      if (!meta || !board || !alight) return undefined;
      legs.push({
        type: "transit",
        mode: meta.mode,
        route_id: String(raw.routeId),
        ...(meta.route_short_name !== undefined
          ? { route_short_name: meta.route_short_name }
          : {}),
        headsign: raw.headsign,
        board,
        alight,
        board_time: toIsoWithTorontoOffset(new Date(raw.boardTimeMs)),
        alight_time: toIsoWithTorontoOffset(new Date(raw.alightTimeMs)),
        num_stops: raw.numStops,
      });
    } else {
      const from = summaries.get(raw.fromId);
      const to = summaries.get(raw.toId);
      if (!from || !to) return undefined;
      legs.push({ type: "transfer", from, to, walk_seconds: raw.walkSeconds });
    }
  }

  const firstTransit = transits[0]!;
  const departMs = firstTransit.boardTimeMs - leadingWalk * 1000;
  const arriveMs = chosen.arriveMs;

  return {
    depart_time: toIsoWithTorontoOffset(new Date(departMs)),
    arrive_time: toIsoWithTorontoOffset(new Date(arriveMs)),
    duration_seconds: Math.round((arriveMs - departMs) / 1000),
    transfers: transits.length - 1,
    legs: mergeConsecutiveTransferLegs(legs),
  };
}

/**
 * Collapse any run of consecutive transfer legs into one direct walk. The
 * ladder never chains footpaths mid-search, but reconstruction can still place
 * a ladder interchange immediately before the egress walk (or after the access
 * walk), producing back-to-back transfers that route the rider through a
 * pointless waypoint. Merging restores the invariant "a transfer leg is
 * flanked by transit legs (or is the sole access/egress walk)". `walk_seconds`
 * is summed — it must stay equal to the walk time the ladder budgeted into the
 * arrival label — while the endpoints become first.from → last.to. A merged
 * zero-length walk (from === to) is dropped.
 */
export function mergeConsecutiveTransferLegs(legs: readonly Leg[]): Leg[] {
  const merged: Leg[] = [];
  for (const leg of legs) {
    const prev = merged[merged.length - 1];
    if (leg.type === "transfer" && prev?.type === "transfer") {
      merged[merged.length - 1] = {
        type: "transfer",
        from: prev.from,
        to: leg.to,
        walk_seconds: prev.walk_seconds + leg.walk_seconds,
      };
    } else {
      merged.push(leg);
    }
  }
  return merged.filter(
    (leg) => leg.type !== "transfer" || leg.from.stop_id !== leg.to.stop_id,
  );
}
