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
      // `query` wins when both are given. Clients with auto-generated forms
      // (e.g. MCP Inspector) routinely fill in every optional object field
      // with a skeleton default — `near: {lat: 0, lon: 0}` — even when the
      // caller only meant to search by name; treating that as a deliberate
      // proximity search silently strands the query and reports zero
      // results near Null Island instead.
      const result = await (query !== undefined
        ? searchStopsByName(deps.db, query, options)
        : near !== undefined
          ? searchStopsNear(
              deps.db,
              near.lat,
              near.lon,
              near.radius_m ?? 500,
              options,
            )
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
