import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { toolError } from "../errors.js";
import { getStopById } from "../gtfs/stops-repository.js";
import { getStopInputShape, getStopOutputShape } from "../schemas/stop.js";
import type { ServerDeps } from "../server.js";

export function registerGetStop(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_stop",
    {
      title: "Get a TTC stop or station",
      description:
        "Details for a single stop_id, including child platforms and routes for a station.",
      inputSchema: getStopInputShape,
      outputSchema: getStopOutputShape,
    },
    async ({ stop_id }): Promise<CallToolResult> => {
      const numericId = Number(stop_id);
      if (!Number.isInteger(numericId)) {
        const dto = {
          error: toolError(
            "invalid_argument",
            `stop_id must be a numeric string, got "${stop_id}".`,
          ),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(dto) }],
          structuredContent: dto,
          isError: true,
        };
      }

      const stop = await getStopById(deps.db, numericId);
      if (!stop) {
        const dto = {
          error: toolError(
            "not_found",
            `No stop found with stop_id "${stop_id}".`,
          ),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(dto) }],
          structuredContent: dto,
          isError: true,
        };
      }

      const dto = { stop };
      return {
        content: [{ type: "text", text: JSON.stringify(dto) }],
        structuredContent: dto,
      };
    },
  );
}
