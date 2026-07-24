import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { listRoutes } from "../gtfs/routes-repository.js";
import {
  listRoutesInputShape,
  listRoutesOutputShape,
} from "../schemas/route.js";
import type { ServerDeps } from "../server.js";

export function registerListRoutes(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "list_routes",
    {
      title: "List TTC routes",
      description:
        "The full TTC route catalog (subway/streetcar/bus), optionally filtered by mode.",
      inputSchema: listRoutesInputShape,
      outputSchema: listRoutesOutputShape,
    },
    async ({ mode }): Promise<CallToolResult> => {
      const routes = await listRoutes(deps.db, mode);
      const dto = { routes };
      return {
        content: [{ type: "text", text: JSON.stringify(dto) }],
        structuredContent: dto,
      };
    },
  );
}
