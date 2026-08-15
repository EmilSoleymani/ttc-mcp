import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { toolError } from "../errors.js";
import { predictedArrivals } from "../gtfs-rt/arrivals-repository.js";
import { getSchedule, toStopSummary } from "../gtfs/schedule-repository.js";
import { getStopById } from "../gtfs/stops-repository.js";
import type { Arrival } from "../schemas/arrival.js";
import {
  getArrivalsInputShape,
  getArrivalsOutputShape,
} from "../schemas/arrival.js";
import type { ServerDeps } from "../server.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;

function errorResult(
  code: Parameters<typeof toolError>[0],
  message: string,
): CallToolResult {
  const dto = {
    arrivals: [],
    realtime_available: false,
    truncated: false,
    error: toolError(code, message),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(dto) }],
    structuredContent: dto,
    isError: true,
  };
}

function ok(dto: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(dto) }],
    structuredContent: dto,
  };
}

export function registerGetArrivals(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_arrivals",
    {
      title: "Get live arrivals at a TTC stop",
      description:
        "Next arrivals at a stop_id (or station, aggregated across platforms). Live predicted times for bus/streetcar; subway and stops with no live trips fall back to scheduled times. Times are absolute ISO 8601 (America/Toronto).",
      inputSchema: getArrivalsInputShape,
      outputSchema: getArrivalsOutputShape,
    },
    async ({ stop_id, route_id, limit }): Promise<CallToolResult> => {
      const stopId = Number(stop_id);
      if (!Number.isInteger(stopId)) {
        return errorResult(
          "invalid_argument",
          `stop_id must be a numeric string, got "${stop_id}".`,
        );
      }
      let routeIdNum: number | undefined;
      if (route_id !== undefined) {
        routeIdNum = Number(route_id);
        if (!Number.isInteger(routeIdNum)) {
          return errorResult(
            "invalid_argument",
            `route_id must be a numeric string, got "${route_id}".`,
          );
        }
      }

      const stopDetail = await getStopById(deps.db, stopId);
      if (!stopDetail) {
        return errorResult(
          "not_found",
          `No stop found with stop_id "${stop_id}".`,
        );
      }

      const cap = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const targetStopIds = stopDetail.is_station
        ? (stopDetail.platforms ?? []).map((p) => Number(p.stop_id))
        : [stopId];

      // Predicted path — bus/streetcar only; RT fetch failure is not fatal.
      if (stopDetail.mode !== "subway") {
        let updates;
        try {
          updates = await deps.rt.getTripUpdates();
        } catch {
          updates = undefined;
        }
        if (updates) {
          const { arrivals, truncated } = await predictedArrivals(
            deps.db,
            updates,
            targetStopIds,
            route_id,
            new Date(),
            cap,
          );
          if (arrivals.length > 0) {
            return ok({
              stop: toStopSummary(stopDetail),
              arrivals,
              realtime_available: true,
              truncated,
              // Same advice the scheduled path gives via getSchedule — the
              // live branch returned `truncated` without it, so identical
              // truncation produced different guidance depending on which
              // branch served the request.
              ...(truncated && route_id === undefined
                ? { hint: "Narrow with route_id to see fewer results." }
                : {}),
            });
          }
        }
      }

      // Scheduled fallback — subway, no live trips, or RT unavailable.
      const sched = await getSchedule(deps.db, {
        stopId,
        ...(routeIdNum !== undefined ? { routeId: routeIdNum } : {}),
        limit: cap,
      });
      if (!sched) {
        return errorResult(
          "not_found",
          `No stop found with stop_id "${stop_id}".`,
        );
      }
      const arrivals: Arrival[] = sched.departures.map((d) => ({
        route_id: d.route_id,
        ...(d.route_short_name !== undefined
          ? { route_short_name: d.route_short_name }
          : {}),
        headsign: d.headsign,
        direction_id: d.direction_id,
        time: d.scheduled_time,
        realtime: false,
        source: "scheduled" as const,
      }));
      return ok({
        stop: sched.stop,
        arrivals,
        realtime_available: false,
        truncated: sched.truncated,
        ...(sched.hint !== undefined ? { hint: sched.hint } : {}),
      });
    },
  );
}
