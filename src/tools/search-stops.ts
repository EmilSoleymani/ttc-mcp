import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { toolError } from "../errors.js";
import {
  searchStopsByName,
  searchStopsNear,
} from "../gtfs/stops-repository.js";
import {
  searchStopsInputShape,
  searchStopsOutputShape,
} from "../schemas/stop.js";
import type { ServerDeps } from "../server.js";

export function registerSearchStops(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "search_stops",
    {
      title: "Search TTC stops",
      description:
        "Find TTC stops/stations by name and/or proximity to a lat/lon point. At least one of `query` or `near` is required. Capped at 20 results; set `truncated` when more matched.",
      inputSchema: searchStopsInputShape,
      outputSchema: searchStopsOutputShape,
    },
    async ({ query, near, mode, limit }): Promise<CallToolResult> => {
      const options = {
        ...(mode !== undefined ? { mode } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
      const result = await (near !== undefined
        ? searchStopsNear(
            deps.db,
            near.lat,
            near.lon,
            near.radius_m ?? 500,
            options,
          )
        : query !== undefined
          ? searchStopsByName(deps.db, query, options)
          : undefined);

      if (result === undefined) {
        const dto = {
          stops: [],
          truncated: false,
          error: toolError(
            "invalid_argument",
            "Provide either `query` (name search) or `near` (proximity search).",
          ),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(dto) }],
          structuredContent: dto,
          isError: true,
        };
      }

      const dto = { stops: result.stops, truncated: result.truncated };
      return {
        content: [{ type: "text", text: JSON.stringify(dto) }],
        structuredContent: dto,
      };
    },
  );
}
