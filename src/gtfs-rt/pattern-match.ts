import type { Client } from "@libsql/client";

import { asText, presence } from "../gtfs/stops-repository.js";

/**
 * #33 — recover a live trip's direction/headsign by matching its ordered stop
 * list against the static schedule.
 *
 * The GTFS-RT `trip_id` is 0% joinable against the ingested static `trips`
 * (TripUpdates are `scheduleRelationship: NEW`, `directionId` pinned to `0`,
 * no `startDate`/`startTime` — see docs/research/rt-trip-id-join.md and
 * PR #31). So `get_arrivals` cannot borrow a static trip's `trip_headsign` /
 * `direction_id` the obvious way. What a TripUpdate *does* carry reliably is
 * an ordered `stopTimeUpdate[]` and a `route_id`; crosswalked to static
 * `stop_id`s (the #11 `rt_stop_crosswalk`), that ordered stop list is a near
 * fingerprint of exactly one of the route's service patterns. Matching it back
 * recovers the direction the RT feed threw away.
 */

/**
 * A distinct stop-sequence pattern on one route: the ordered static `stop_id`s
 * a set of trips share, plus the headsign/direction those trips carry. Many
 * scheduled trips collapse to a handful of patterns per route (the two
 * directions, plus short-turns/branches).
 */
export interface RoutePattern {
  headsign: string;
  direction_id: number;
  /** Ordered by `stop_sequence`. */
  stopIds: number[];
  /**
   * How many static trips realise this exact stop sequence. Used to pick a
   * direction's canonical headsign when the live trip's *branch* is undecided
   * but its direction is not.
   */
  tripCount: number;
}

/** The identity a confident pattern match recovers. */
export interface PatternMatch {
  headsign: string;
  direction_id: number;
}

// A candidate pattern must cover at least this fraction of the live trip's
// (crosswalked) stops in order to be considered at all — below it, the RT
// stop list is too unlike any scheduled pattern to trust.
export const DEFAULT_COVERAGE_THRESHOLD = 0.6;
// ...and the winner must beat its best rival by this margin. The test is
// applied twice, to two independent questions: first to *direction* (a trip
// still on a route's common trunk, where both directions score equally, is
// not assigned one by a coin-flip — it stays unmatched), then to *branch*
// among the patterns of the winning direction. The two are separable far more
// often than not: on the live feed ~90% of the trips that fail the branch test
// have every candidate agreeing on direction, so collapsing both questions
// into one threw away a direction that was never in doubt.
export const DEFAULT_MARGIN = 0.2;

/**
 * The most-tripped headsign among `patterns` — the schedule's own canonical
 * label for a direction. Used when the live trip's direction is settled but
 * its branch is not: naming the direction's usual destination is the honest
 * answer, where naming the winning branch's would assert a terminal the trip
 * may never reach. Ties break on the headsign string for determinism.
 */
function canonicalHeadsign(patterns: RoutePattern[]): string | undefined {
  let best: RoutePattern | undefined;
  for (const p of patterns) {
    if (
      !best ||
      p.tripCount > best.tripCount ||
      (p.tripCount === best.tripCount && p.headsign < best.headsign)
    ) {
      best = p;
    }
  }
  return best === undefined || best.headsign === "" ? undefined : best.headsign;
}

/**
 * Distinct stop-sequence patterns for a route, each carrying the headsign /
 * direction of the (first) trip that realises it. `routeId` is the RT
 * `trip.routeId` string; `trips.route_id` is the integer PK, so it's coerced
 * the same way `routeShortNames` does.
 *
 * Cost note: this reads every `stop_times` row for the route's trips and
 * de-dupes to patterns in memory. It is only ever called for the ≤ `limit+1`
 * live predictions surfaced at one stop (memoised per route within a call),
 * i.e. the one-to-few surface routes actually serving that stop — never the
 * whole network.
 */
export async function loadRoutePatterns(
  client: Client,
  routeId: string,
): Promise<RoutePattern[]> {
  const routeNum = Number(routeId);
  if (!Number.isInteger(routeNum)) return [];
  const result = await client.execute({
    sql: `SELECT t.trip_id AS trip_id, t.trip_headsign AS trip_headsign,
                 t.direction_id AS direction_id, st.stop_id AS stop_id
          FROM trips t JOIN stop_times st ON st.trip_id = t.trip_id
          WHERE t.route_id = ?
          ORDER BY t.trip_id, st.stop_sequence`,
    args: [routeNum],
  });

  // Rows arrive grouped by trip_id (ORDER BY trip_id, stop_sequence); fold each
  // trip's rows into one ordered stop list, then de-dupe by that list so each
  // distinct pattern is kept once (first-seen headsign/direction wins).
  const byKey = new Map<string, RoutePattern>();
  let currentTrip: number | undefined;
  let stopIds: number[] = [];
  let headsign = "";
  let directionId = 0;

  const flush = (): void => {
    if (stopIds.length === 0) return;
    const key = stopIds.join(",");
    const existing = byKey.get(key);
    if (existing) {
      existing.tripCount++;
      return;
    }
    byKey.set(key, {
      headsign,
      direction_id: directionId,
      stopIds,
      tripCount: 1,
    });
  };

  for (const row of result.rows) {
    const tripId = Number(row.trip_id);
    if (tripId !== currentTrip) {
      flush();
      currentTrip = tripId;
      stopIds = [];
      headsign =
        presence(
          row.trip_headsign === null ? null : asText(row.trip_headsign),
        ) ?? "";
      directionId =
        row.direction_id === null || row.direction_id === undefined
          ? 0
          : Number(row.direction_id);
    }
    stopIds.push(Number(row.stop_id));
  }
  flush();

  return [...byKey.values()];
}

/**
 * Length of the longest common subsequence (order-preserving) of two stop-id
 * lists. Order preservation is what distinguishes the two directions of a
 * route: a live trip running one way is a subsequence of that direction's
 * pattern but not of the reversed one.
 */
export function lcsLength(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? (prev[j - 1] ?? 0) + 1
          : Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/**
 * Identity recovered for a live trip's crosswalked stop list, or `null` when
 * not even its direction can be attributed confidently.
 *
 * A pattern is a candidate only if it clears `threshold` coverage
 * (`lcs(rtStopIds, pattern) / rtStopIds.length`) *and* actually serves
 * `queriedStopId` — the stop the arrival is for, so the recovered direction is
 * the one relevant to this stop and a scheduled time is resolvable there.
 *
 * Direction and headsign are then decided as two separate questions, because
 * they fail independently:
 *
 *  - **Direction** — the best candidate must beat the best candidate of a
 *    *different* direction by `margin`. Failing this means the trip is still
 *    on shared trunk track where both directions score alike, so nothing is
 *    returned rather than a coin-flip direction.
 *  - **Branch** — among the winning direction's candidates, the best must beat
 *    the best candidate carrying a *different headsign* by `margin`. Failing
 *    this means only the branch is undecided, not the direction, so the
 *    direction's canonical headsign is returned rather than asserting a
 *    terminal this trip may never reach.
 */
export function matchPattern(
  rtStopIds: number[],
  patterns: RoutePattern[],
  queriedStopId: number,
  threshold: number = DEFAULT_COVERAGE_THRESHOLD,
  margin: number = DEFAULT_MARGIN,
): PatternMatch | null {
  if (rtStopIds.length === 0) return null;

  const scored = patterns
    .filter((p) => p.stopIds.includes(queriedStopId))
    .map((p) => ({
      pattern: p,
      coverage: lcsLength(rtStopIds, p.stopIds) / rtStopIds.length,
    }))
    .filter((s) => s.coverage >= threshold)
    .sort((a, b) => b.coverage - a.coverage);

  const best = scored[0];
  if (!best) return null;
  const direction_id = best.pattern.direction_id;

  // `scored` is sorted descending, so the first rival found is the strongest.
  const rivalDirection = scored.find(
    (s) => s.pattern.direction_id !== direction_id,
  );
  if (rivalDirection && best.coverage - rivalDirection.coverage < margin) {
    return null;
  }

  const sameDirection = scored.filter(
    (s) => s.pattern.direction_id === direction_id,
  );
  const rivalBranch = sameDirection.find(
    (s) => s.pattern.headsign !== best.pattern.headsign,
  );
  const branchUndecided =
    rivalBranch !== undefined && best.coverage - rivalBranch.coverage < margin;

  return {
    headsign: branchUndecided
      ? (canonicalHeadsign(sameDirection.map((s) => s.pattern)) ??
        best.pattern.headsign)
      : best.pattern.headsign,
    direction_id,
  };
}
