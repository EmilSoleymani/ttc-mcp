import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { alertsMatching } from "../gtfs-rt/alerts-repository.js";
import { routeModeIndex } from "../gtfs/routes-repository.js";
import { stopModeIndex } from "../gtfs/stops-repository.js";
import { toolError } from "../errors.js";
import { getAlertsInputShape, getAlertsOutputShape } from "../schemas/alert.js";
import type { ServerDeps } from "../server.js";

const MAX_ALERTS = 50;

export function registerGetAlerts(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_alerts",
    {
      title: "Get TTC service alerts",
      description:
        "Live service alerts (elevator/escalator outages, detours, delays, no-service, planned work), filterable by mode/route/stop/derived category. Subway-inclusive — unlike get_vehicles/get_arrivals, TTC publishes this feed for every mode.",
      inputSchema: getAlertsInputShape,
      outputSchema: getAlertsOutputShape,
    },
    async ({
      mode,
      route_id,
      stop_id,
      category,
      limit,
    }): Promise<CallToolResult> => {
      let entities;
      try {
        entities = await deps.rt.getAlerts();
      } catch {
        const dto = {
          alerts: [],
          truncated: false,
          error: toolError(
            "upstream_unavailable",
            "Failed to fetch live service alerts after retries.",
          ),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(dto) }],
          structuredContent: dto,
          isError: true,
        };
      }

      const [routeModeById, stopModeById] = await Promise.all([
        routeModeIndex(deps.db),
        stopModeIndex(deps.db),
      ]);
      const alerts = alertsMatching(
        entities,
        { routeModeById, stopModeById },
        {
          ...(mode !== undefined ? { mode } : {}),
          ...(route_id !== undefined ? { routeId: route_id } : {}),
          ...(stop_id !== undefined ? { stopId: stop_id } : {}),
          ...(category !== undefined ? { category } : {}),
        },
      );

      const cap = Math.min(limit ?? MAX_ALERTS, MAX_ALERTS);
      const truncated = alerts.length > cap;
      const dto = { alerts: alerts.slice(0, cap), truncated };
      return {
        content: [{ type: "text", text: JSON.stringify(dto) }],
        structuredContent: dto,
      };
    },
  );
}
