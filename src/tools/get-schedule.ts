import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { toolError } from "../errors.js";
import { getSchedule } from "../gtfs/schedule-repository.js";
import {
  getScheduleInputShape,
  getScheduleOutputShape,
} from "../schemas/schedule.js";
import type { ServerDeps } from "../server.js";

function errorResult(
  code: Parameters<typeof toolError>[0],
  message: string,
): CallToolResult {
  const dto = {
    departures: [],
    truncated: false,
    error: toolError(code, message),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(dto) }],
    structuredContent: dto,
    isError: true,
  };
}

export function registerGetSchedule(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_schedule",
    {
      title: "Get scheduled departures at a TTC stop",
      description:
        "Next-N scheduled departures at a stop_id (or station, aggregated across platforms), honoring the service day's calendar. Times are absolute ISO 8601 (America/Toronto).",
      inputSchema: getScheduleInputShape,
      outputSchema: getScheduleOutputShape,
    },
    async ({ stop_id, route_id, when, limit }): Promise<CallToolResult> => {
      const stopId = Number(stop_id);
      if (!Number.isInteger(stopId)) {
        return errorResult(
          "invalid_argument",
          `stop_id must be a numeric string, got "${stop_id}".`,
        );
      }

      let routeId: number | undefined;
      if (route_id !== undefined) {
        routeId = Number(route_id);
        if (!Number.isInteger(routeId)) {
          return errorResult(
            "invalid_argument",
            `route_id must be a numeric string, got "${route_id}".`,
          );
        }
      }

      let whenDate: Date | undefined;
      if (when !== undefined) {
        whenDate = new Date(when);
        if (Number.isNaN(whenDate.getTime())) {
          return errorResult(
            "invalid_argument",
            `when must be a valid ISO 8601 timestamp, got "${when}".`,
          );
        }
      }

      const result = await getSchedule(deps.db, {
        stopId,
        ...(routeId !== undefined ? { routeId } : {}),
        ...(whenDate !== undefined ? { when: whenDate } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (!result) {
        return errorResult(
          "not_found",
          `No stop found with stop_id "${stop_id}".`,
        );
      }

      const dto = {
        stop: result.stop,
        departures: result.departures,
        truncated: result.truncated,
        ...(result.hint !== undefined ? { hint: result.hint } : {}),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(dto) }],
        structuredContent: dto,
      };
    },
  );
}
