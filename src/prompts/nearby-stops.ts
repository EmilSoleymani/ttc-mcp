import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { modeSchema } from "../schemas/stop.js";

export const nearbyStopsArgsShape = {
  lat: z.coerce.number().describe("Latitude of the point to search near."),
  lon: z.coerce.number().describe("Longitude of the point to search near."),
  radius_m: z.coerce
    .number()
    .positive()
    .optional()
    .describe("Search radius in meters (default 500)."),
  mode: modeSchema
    .optional()
    .describe("Optional mode filter: subway, streetcar, or bus."),
};

/** Wraps `search_stops` (proximity) + `get_stop`: nearby stops with details. */
export function registerNearbyStops(server: McpServer): void {
  server.registerPrompt(
    "nearby_stops",
    {
      title: "Nearby stops",
      description:
        "TTC stops/stations near a lat/lon point, with platform and route details for the closest matches.",
      argsSchema: nearbyStopsArgsShape,
    },
    ({ lat, lon, radius_m, mode }): GetPromptResult => {
      const radiusClause =
        radius_m !== undefined ? `, radius_m ${radius_m}` : "";
      const modeClause = mode !== undefined ? `, mode "${mode}"` : "";

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Call the search_stops tool with near: { lat: ${lat}, lon: ${lon}${radiusClause} }${modeClause}. ` +
                "For the closest few results, call get_stop on each stop_id to get " +
                "its platforms and the routes serving it. Then list the nearby " +
                "stops/stations, nearest first, with their mode(s) and which " +
                "routes stop there. If nothing is found, suggest widening the " +
                "radius.",
            },
          },
        ],
      };
    },
  );
}
