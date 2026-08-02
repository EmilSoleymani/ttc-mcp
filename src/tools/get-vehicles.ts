import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { toolError } from "../errors.js";
import { vehiclesForRoute } from "../gtfs-rt/vehicles-repository.js";
import { getRouteById } from "../gtfs/routes-repository.js";
import {
  getVehiclesInputShape,
  getVehiclesOutputShape,
} from "../schemas/vehicle.js";
import type { ServerDeps } from "../server.js";

const MAX_VEHICLES = 50;

function errorResult(
  routeId: string,
  code: Parameters<typeof toolError>[0],
  message: string,
): CallToolResult {
  const dto = {
    route_id: routeId,
    vehicles: [],
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

export function registerGetVehicles(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_vehicles",
    {
      title: "Get live TTC vehicle positions",
      description:
        "Live vehicle positions for a route, filtered server-side. Bus and streetcar only — TTC publishes no subway vehicle positions, so a subway route_id returns an empty (not error) result.",
      inputSchema: getVehiclesInputShape,
      outputSchema: getVehiclesOutputShape,
    },
    async ({ route_id, limit }): Promise<CallToolResult> => {
      const numericId = Number(route_id);
      if (!Number.isInteger(numericId)) {
        return errorResult(
          route_id,
          "invalid_argument",
          `route_id must be a numeric string, got "${route_id}".`,
        );
      }

      const route = await getRouteById(deps.db, numericId);
      if (!route) {
        return errorResult(
          route_id,
          "not_found",
          `No route found with route_id "${route_id}".`,
        );
      }

      // No subway VehiclePositions feed exists at all — success-shaped empty
      // result, not a hard error (docs/spec/realtime-integration.md #3).
      if (route.mode === "subway") {
        const dto = {
          route_id,
          vehicles: [],
          realtime_available: false,
          truncated: false,
          note: "TTC does not publish subway vehicle positions.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(dto) }],
          structuredContent: dto,
        };
      }

      let positions;
      try {
        positions = await deps.rt.getVehiclePositions();
      } catch {
        return errorResult(
          route_id,
          "upstream_unavailable",
          "Failed to fetch live vehicle positions after retries.",
        );
      }

      const cap = Math.min(limit ?? MAX_VEHICLES, MAX_VEHICLES);
      const vehicles = vehiclesForRoute(positions, route_id);
      const truncated = vehicles.length > cap;
      const dto = {
        route_id,
        vehicles: vehicles.slice(0, cap),
        realtime_available: true,
        truncated,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(dto) }],
        structuredContent: dto,
      };
    },
  );
}
