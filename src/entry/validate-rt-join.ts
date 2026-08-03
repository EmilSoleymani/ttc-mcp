#!/usr/bin/env node
// Research/validation harness for docs/spec/realtime-integration.md #4's
// flagged risk: does the live GTFS-RT `trip_id` actually match the ingested
// static `trips` PK? Samples one live TripUpdates feed, reconciles each
// distinct RT `trip_id` against the ingested `trips` table, and reports the
// overlap plus the never-drop fallback coverage. Prints a human report to
// stderr and a machine-readable JSON summary to stdout.
//
// Requires: an ingested schedule DB (`npm run ingest`, LIBSQL_URL) AND
// outbound network to the TTC RT endpoint (GTFS_RT_BASE_URL). Not runnable in
// a network-restricted sandbox — see the doc for the reference numbers.
import type { transit_realtime } from "gtfs-realtime-bindings";

import { resolveQueryClient } from "../gtfs/db-client.js";
import {
  countStaticTrips,
  parseRtTripId,
  staticTripIdsExisting,
} from "../gtfs/trips-repository.js";
import { resolveRtClient } from "../gtfs-rt/rt-client.js";
import { resolveArrivalIdentity } from "../gtfs-rt/trip-join.js";

interface JoinReport {
  static_trip_count: number;
  rt_trip_updates: number;
  distinct_rt_trip_ids: number;
  numeric_trip_ids: number;
  non_numeric_trip_ids: number;
  matched_trip_ids: number;
  unmatched_trip_ids: number;
  overlap_pct: number;
  // The never-drop guarantee, measured: of the RT updates whose trip_id did
  // NOT match static, how many still resolve to a usable identity (an RT
  // route_id) via the fallback — i.e. survive rather than get dropped.
  unmatched_updates: number;
  unmatched_updates_recovered: number;
  unmatched_updates_unrecoverable: number;
  sample_unmatched_trip_ids: string[];
  sample_non_numeric_trip_ids: string[];
}

function tripIdOf(t: transit_realtime.ITripUpdate): string | null | undefined {
  return t.trip?.tripId;
}

const client = resolveQueryClient();
const rt = resolveRtClient();

const staticTripCount = await countStaticTrips(client);
const updates = await rt.getTripUpdates();

const distinct = new Set<string>();
const numericByTripId = new Map<string, number>();
const nonNumeric: string[] = [];
for (const u of updates) {
  const raw = tripIdOf(u);
  if (raw == null || raw === "") continue;
  distinct.add(raw);
  const parsed = parseRtTripId(raw);
  if (parsed === null) nonNumeric.push(raw);
  else numericByTripId.set(raw, parsed);
}

const existing = await staticTripIdsExisting(client, [
  ...numericByTripId.values(),
]);

const matched = new Set<string>();
const unmatched = new Set<string>();
for (const [raw, parsed] of numericByTripId) {
  if (existing.has(parsed)) matched.add(raw);
  else unmatched.add(raw);
}
// Non-numeric ids can never match a numeric PK — count them as unmatched.
for (const raw of nonNumeric) unmatched.add(raw);

// Per-update never-drop measurement: run each update through the real
// fallback resolver and confirm an unmatched trip_id still yields an identity.
let unmatchedUpdates = 0;
let recovered = 0;
for (const u of updates) {
  const raw = tripIdOf(u);
  const parsed = parseRtTripId(raw);
  const isMatched = parsed !== null && existing.has(parsed);
  if (isMatched) continue;
  unmatchedUpdates++;
  const identity = resolveArrivalIdentity(
    { tripId: raw, routeId: u.trip?.routeId },
    undefined,
  );
  if (identity) recovered++;
}

const report: JoinReport = {
  static_trip_count: staticTripCount,
  rt_trip_updates: updates.length,
  distinct_rt_trip_ids: distinct.size,
  numeric_trip_ids: numericByTripId.size,
  non_numeric_trip_ids: nonNumeric.length,
  matched_trip_ids: matched.size,
  unmatched_trip_ids: unmatched.size,
  overlap_pct:
    distinct.size === 0
      ? 0
      : Math.round((matched.size / distinct.size) * 1000) / 10,
  unmatched_updates: unmatchedUpdates,
  unmatched_updates_recovered: recovered,
  unmatched_updates_unrecoverable: unmatchedUpdates - recovered,
  sample_unmatched_trip_ids: [...unmatched].slice(0, 10),
  sample_non_numeric_trip_ids: nonNumeric.slice(0, 10),
};

console.error("=== GTFS-RT trip_id ↔ static trips join validation ===");
console.error(`Static trips ingested:        ${String(staticTripCount)}`);
console.error(`Live TripUpdates in sample:   ${String(updates.length)}`);
console.error(`Distinct RT trip_ids:         ${String(distinct.size)}`);
console.error(
  `  numeric / non-numeric:      ${String(numericByTripId.size)} / ${String(nonNumeric.length)}`,
);
console.error(
  `Matched in static:            ${String(matched.size)} (${String(report.overlap_pct)}% overlap)`,
);
console.error(`Unmatched trip_ids:           ${String(unmatched.size)}`);
console.error(
  `Never-drop fallback:          ${String(recovered)}/${String(unmatchedUpdates)} unmatched updates recovered, ${String(report.unmatched_updates_unrecoverable)} unrecoverable`,
);
if (report.sample_unmatched_trip_ids.length > 0) {
  console.error(
    `Sample unmatched trip_ids:    ${report.sample_unmatched_trip_ids.join(", ")}`,
  );
}

// The join is trustworthy for get_arrivals when the fallback never drops an
// unmatched update. Overlap being <100% is expected and fine; an
// unrecoverable update (no route_id to fall back to) is the only red flag.
if (report.unmatched_updates_unrecoverable > 0) {
  console.error(
    "WARNING: some unmatched updates carried no route_id — investigate before relying on the fallback.",
  );
}

console.log(JSON.stringify(report, null, 2));
