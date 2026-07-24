import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { toolError } from "../errors.js";
import { getRouteById } from "../gtfs/routes-repository.js";
import { getRouteInputShape, getRouteOutputShape } from "../schemas/route.js";
import type { ServerDeps } from "../server.js";

export function registerGetRoute(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_route",
    {
      title: "Get a TTC route",
      description:
        "Details for a single route_id: directions and (capped) stops per direction.",
      inputSchema: getRouteInputShape,
      outputSchema: getRouteOutputShape,
    },
    async ({ route_id }): Promise<CallToolResult> => {
      const numericId = Number(route_id);
      if (!Number.isInteger(numericId)) {
        const dto = {
          error: toolError(
            "invalid_argument",
            `route_id must be a numeric string, got "${route_id}".`,
          ),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(dto) }],
          structuredContent: dto,
          isError: true,
        };
      }

      const route = await getRouteById(deps.db, numericId);
      if (!route) {
        const dto = {
          error: toolError(
            "not_found",
            `No route found with route_id "${route_id}".`,
          ),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(dto) }],
          structuredContent: dto,
          isError: true,
        };
      }

      const dto = { route };
      return {
        content: [{ type: "text", text: JSON.stringify(dto) }],
        structuredContent: dto,
      };
    },
  );
}
