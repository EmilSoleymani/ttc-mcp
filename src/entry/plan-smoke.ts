#!/usr/bin/env node
// Real-DB smoke for plan_trip (issue #12): runs a few plans against an
// ingested schedule DB and asserts sane structure, exiting non-zero on
// failure. Unlike the weekly upstream-domain smoke (src/entry/smoke.ts),
// plan_trip has no upstream domain — it exercises the routing loop against
// real Toronto data (catches, e.g., the station -> platform access gap the
// synthetic fixture can't). Skips (exit 0) when no local DB file is present,
// so it never breaks CI, where the ingested DB is absent.
import { existsSync } from "node:fs";

import type { Client } from "@libsql/client";

import { resolveQueryClient } from "../gtfs/db-client.js";
import {
  planDepartAfter,
  resolveBothEndpoints,
} from "../gtfs/routing/index.js";
import { asText, haversineMeters } from "../gtfs/stops-repository.js";
import type { Itinerary } from "../schemas/itinerary.js";

// A walk leg between stops further apart than this is physically implausible —
// it means a bogus transfer edge (e.g. the pathway-namespace bug, issue #39)
// let the plan "teleport". Generous vs. the ~250m street-transfer radius.
const MAX_TRANSFER_METERS = 600;

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

/** A weekday service date within the ingested calendar window, at ~08:00
 * Toronto (noon UTC), so the plans have service to walk. */
async function departureWithinCalendar(client: Client): Promise<Date> {
  const row = (
    await client.execute("SELECT MIN(start_date) AS s FROM calendar")
  ).rows[0];
  const start = row?.s != null ? Number(row.s) : 0;
  let date = new Date(
    Date.UTC(
      Math.floor(start / 10000),
      (Math.floor(start / 100) % 100) - 1,
      start % 100,
      12,
    ),
  );
  // Advance to a weekday (Mon–Fri), which always carries service.
  for (
    let i = 0;
    i < 7 && (date.getUTCDay() === 0 || date.getUTCDay() === 6);
    i++
  ) {
    date = new Date(date.getTime() + 86_400_000);
  }
  return date;
}

/** The subway (route_type 1) station parent that is furthest in the given
 * direction — a terminus, guaranteeing a long cross-line trip. */
async function terminusStation(
  client: Client,
  routeShortName: string,
  order: "MIN(c.stop_lon)" | "MAX(c.stop_lat)",
): Promise<{ id: string; name: string } | undefined> {
  const result = await client.execute({
    sql: `SELECT p.stop_id AS id, p.stop_name AS name, ${order} AS metric
          FROM stops c
          JOIN stops p ON p.stop_id = c.parent_station
          JOIN stop_times st ON st.stop_id = c.stop_id
          JOIN trips t ON t.trip_id = st.trip_id
          JOIN routes r ON r.route_id = t.route_id AND r.route_short_name = ?
          WHERE c.stop_lon IS NOT NULL AND c.stop_lat IS NOT NULL
          GROUP BY p.stop_id
          ORDER BY metric ${order.startsWith("MIN") ? "ASC" : "DESC"}
          LIMIT 1`,
    args: [routeShortName],
  });
  const r = result.rows[0];
  return r ? { id: asText(r.id), name: asText(r.name) } : undefined;
}

function timesMonotonic(itin: Itinerary): boolean {
  const stamps: string[] = [];
  for (const leg of itin.legs) {
    if (leg.type === "transit") stamps.push(leg.board_time, leg.alight_time);
  }
  for (let i = 1; i < stamps.length; i++) {
    if (new Date(stamps[i]!).getTime() < new Date(stamps[i - 1]!).getTime()) {
      return false;
    }
  }
  return itin.arrive_time > itin.depart_time;
}

/** The furthest-apart transfer leg in metres — a teleport detector. */
function maxTransferMeters(itin: Itinerary): number {
  let max = 0;
  for (const leg of itin.legs) {
    if (leg.type !== "transfer") continue;
    const m = haversineMeters(
      leg.from.lat,
      leg.from.lon,
      leg.to.lat,
      leg.to.lon,
    );
    if (m > max) max = m;
  }
  return max;
}

async function run(): Promise<void> {
  const url = process.env.LIBSQL_URL ?? "file:./data/ttc.db";
  if (url.startsWith("file:")) {
    const path = url.slice("file:".length);
    if (!existsSync(path)) {
      console.error(
        `[SKIP] plan_trip smoke: no ingested DB at ${path} (run \`npm run ingest\`). Not a failure.`,
      );
      return;
    }
  }

  const client = resolveQueryClient();
  try {
    const depart = await departureWithinCalendar(client);
    const west = await terminusStation(client, "2", "MIN(c.stop_lon)");
    const north = await terminusStation(client, "1", "MAX(c.stop_lat)");

    // 1) A cross-line plan between two subway termini: must transfer.
    if (!west || !north) {
      record(
        "cross-line plan",
        false,
        "could not find Line 1 / Line 2 terminus stations",
      );
    } else {
      const both = await resolveBothEndpoints(client, west.id, north.id);
      if (both.kind !== "ok") {
        record("cross-line plan", false, `endpoints resolved as ${both.kind}`);
      } else {
        const itin = await planDepartAfter(client, {
          from: both.from,
          to: both.to,
          fromAccess: both.fromAccess,
          toAccess: both.toAccess,
          depart,
          maxTransfers: 3,
        });
        const transitLegs =
          itin?.legs.filter((l) => l.type === "transit") ?? [];
        const routes = new Set(
          transitLegs.map((l) => (l.type === "transit" ? l.route_id : "")),
        );
        const farthestWalk = itin ? maxTransferMeters(itin) : 0;
        const good =
          itin !== undefined &&
          transitLegs.length >= 2 &&
          routes.size >= 2 &&
          itin.transfers >= 1 &&
          timesMonotonic(itin) &&
          farthestWalk <= MAX_TRANSFER_METERS;
        record(
          "cross-line plan",
          good,
          itin
            ? `${west.name} -> ${north.name}: ${String(itin.legs.length)} legs, ${String(itin.transfers)} transfer(s), ${String(Math.round(itin.duration_seconds / 60))} min, farthest walk ${String(Math.round(farthestWalk))}m`
            : `${west.name} -> ${north.name}: no itinerary`,
        );
      }
    }

    // 2) Ambiguous name resolves to candidates (success), not a route.
    const ambiguous = await resolveBothEndpoints(
      client,
      "Dundas",
      north?.id ?? "1",
    );
    record(
      "ambiguous endpoint -> candidates",
      ambiguous.kind === "candidates" &&
        ambiguous.candidates.endpoint === "from",
      ambiguous.kind === "candidates"
        ? `${String(ambiguous.candidates.matches.length)} candidates for \`from\``
        : `expected candidates, got ${ambiguous.kind}`,
    );
  } finally {
    client.close();
  }

  let allOk = true;
  for (const r of results) {
    console.error(`[${r.ok ? "OK" : "FAILED"}] ${r.name}: ${r.detail}`);
    if (!r.ok) allOk = false;
  }
  if (!allOk) {
    console.error("plan_trip smoke: one or more checks failed.");
    process.exit(1);
  }
  console.error("plan_trip smoke: all checks passed.");
}

await run();
