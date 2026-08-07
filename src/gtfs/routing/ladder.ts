import type { Client } from "@libsql/client";

import type { Mode } from "../../schemas/stop.js";
import { activeServiceIds } from "../schedule-repository.js";
import {
  absoluteTimeFor,
  addDays,
  type ServiceDate,
  secondsSinceServiceMidnight,
  serviceDateAt,
} from "../service-time.js";
import {
  type Boarding,
  type DownstreamStop,
  fetchBoardings,
  fetchDownstream,
  fetchFootpaths,
  type MarkedStop,
} from "./queries.js";

// The bounded RAPTOR-lite earliest-arrival ladder (depart-after) for plan_trip
// (docs/superpowers/specs/2026-08-04-plan-trip-design.md §"Algorithm", ADR
// 0001/0002). Labels are absolute epoch milliseconds so trips from adjacent
// service days compose. Parent pointers let PR2's reconstruction rebuild legs.

// A trip plan shouldn't "wait until tomorrow": arrivals beyond this horizon
// past the requested departure are discarded, bounding the search.
export const MAX_HORIZON_SECONDS = 6 * 3600;

/** How a stop's best label was reached — the backtrack pointer. */
export type Parent =
  | { via: "access"; walkSeconds: number }
  | { via: "transfer"; fromStopId: number; walkSeconds: number }
  | {
      via: "transit";
      boardStopId: number;
      boardSeq: number;
      boardTimeMs: number;
      routeId: number;
      headsign: string;
      directionId: number | null;
      alightSeq: number;
      tripId: number;
    };

export interface Label {
  /** Absolute epoch ms of the earliest known arrival at the stop. */
  arrival: number;
  parent: Parent;
}

export interface OriginAccess {
  stopId: number;
  walk: number;
}

export interface LadderParams {
  originAccess: readonly OriginAccess[];
  departMs: number;
  maxTransfers: number;
  modes?: readonly Mode[];
}

interface DatedService {
  date: ServiceDate;
  serviceIds: number[];
}

/**
 * Run the depart-after ladder from the origin access stops, returning the best
 * (earliest-arrival) label per reached stop. Rounds = `maxTransfers + 1`; each
 * round boards+rides from the marked set, then relaxes footpaths from the
 * stops a transit leg just improved (never back-to-back transfers).
 */
export async function runLadder(
  client: Client,
  params: LadderParams,
): Promise<Map<number, Label>> {
  // Second-align the departure so labels and whole-second GTFS times compare
  // exactly.
  const departMs = Math.floor(params.departMs / 1000) * 1000;
  const horizonMs = departMs + MAX_HORIZON_SECONDS * 1000;

  const depart = new Date(departMs);
  const day = serviceDateAt(depart);
  const dated: DatedService[] = [];
  // D-1 (overnight carryover), D, D+1 (a search that crosses midnight).
  for (const delta of [-1, 0, 1]) {
    const date = addDays(day, delta);
    dated.push({ date, serviceIds: await activeServiceIds(client, date) });
  }

  const best = new Map<number, Label>();
  for (const a of params.originAccess) {
    const arrival = departMs + a.walk * 1000;
    const existing = best.get(a.stopId);
    if (!existing || arrival < existing.arrival) {
      best.set(a.stopId, {
        arrival,
        parent: { via: "access", walkSeconds: a.walk },
      });
    }
  }
  let marked = new Set(best.keys());

  for (let round = 0; round <= params.maxTransfers; round++) {
    if (marked.size === 0) break;
    const transitImproved = await boardAndRide(
      client,
      marked,
      best,
      dated,
      horizonMs,
      params.modes,
    );
    const transferImproved = await relaxFootpaths(
      client,
      transitImproved,
      best,
      horizonMs,
    );
    marked = new Set([...transitImproved, ...transferImproved]);
  }
  return best;
}

/** Board the earliest trip per pattern at each marked stop (across candidate
 * service days) and relax downstream arrival labels. Returns the stops
 * improved. */
async function boardAndRide(
  client: Client,
  marked: ReadonlySet<number>,
  best: Map<number, Label>,
  dated: readonly DatedService[],
  horizonMs: number,
  modes: readonly Mode[] | undefined,
): Promise<Set<number>> {
  const improved = new Set<number>();
  const markedList = [...marked];

  const boardings: { boarding: Boarding; date: ServiceDate }[] = [];
  for (const { date, serviceIds } of dated) {
    if (serviceIds.length === 0) continue;
    const markedForDate: MarkedStop[] = markedList.map((stopId) => ({
      stop_id: stopId,
      min_dep: secondsSinceServiceMidnight(
        date,
        new Date(best.get(stopId)!.arrival),
      ),
    }));
    const rows = await fetchBoardings(client, markedForDate, serviceIds, modes);
    for (const boarding of rows) boardings.push({ boarding, date });
  }
  if (boardings.length === 0) return improved;

  const tripIds = [...new Set(boardings.map((x) => x.boarding.trip_id))];
  const downstream = await fetchDownstream(client, tripIds);
  const byTrip = new Map<number, DownstreamStop[]>();
  for (const stop of downstream) {
    const list = byTrip.get(stop.trip_id);
    if (list) list.push(stop);
    else byTrip.set(stop.trip_id, [stop]);
  }

  for (const { boarding, date } of boardings) {
    const boardMs = absoluteTimeFor(date, boarding.dep).getTime();
    if (boardMs > horizonMs) continue;
    // The boarding must not precede the label we're departing from.
    if (boardMs < best.get(boarding.stop_id)!.arrival) continue;

    const stops = byTrip.get(boarding.trip_id) ?? [];
    const boardRow = stops.find(
      (s) => s.stop_id === boarding.stop_id && s.dep === boarding.dep,
    );
    if (!boardRow) continue;
    const boardSeq = boardRow.stop_sequence;

    for (const s of stops) {
      if (s.stop_sequence <= boardSeq) continue;
      const arrSec = s.arr ?? s.dep;
      if (arrSec === null) continue;
      const arrMs = absoluteTimeFor(date, arrSec).getTime();
      if (arrMs > horizonMs) continue;
      const existing = best.get(s.stop_id);
      if (!existing || arrMs < existing.arrival) {
        best.set(s.stop_id, {
          arrival: arrMs,
          parent: {
            via: "transit",
            boardStopId: boarding.stop_id,
            boardSeq,
            boardTimeMs: boardMs,
            routeId: boarding.route_id,
            headsign: boarding.headsign,
            directionId: boarding.direction_id,
            alightSeq: s.stop_sequence,
            tripId: boarding.trip_id,
          },
        });
        improved.add(s.stop_id);
      }
    }
  }
  return improved;
}

/** Relax footpaths out of the stops a transit leg just improved (never from a
 * stop that was itself reached by a footpath — no back-to-back transfers). */
async function relaxFootpaths(
  client: Client,
  transitImproved: ReadonlySet<number>,
  best: Map<number, Label>,
  horizonMs: number,
): Promise<Set<number>> {
  const improved = new Set<number>();
  if (transitImproved.size === 0) return improved;

  const footpaths = await fetchFootpaths(client, [...transitImproved]);
  for (const fp of footpaths) {
    const fromLabel = best.get(fp.from_stop_id);
    if (!fromLabel) continue;
    const arrMs = fromLabel.arrival + fp.min_walk_seconds * 1000;
    if (arrMs > horizonMs) continue;
    const existing = best.get(fp.to_stop_id);
    if (!existing || arrMs < existing.arrival) {
      best.set(fp.to_stop_id, {
        arrival: arrMs,
        parent: {
          via: "transfer",
          fromStopId: fp.from_stop_id,
          walkSeconds: fp.min_walk_seconds,
        },
      });
      improved.add(fp.to_stop_id);
    }
  }
  return improved;
}
