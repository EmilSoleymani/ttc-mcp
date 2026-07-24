import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { selectFares } from "./data/fares.js";

// Resource content mirrors the get_fare tool's DTO exactly (both call
// selectFares()), so the browsable Resource and the callable Tool cannot drift
// (tool-schemas spec: catalog + fares exposed as both Resources and mirror
// Tools).
export function registerResources(server: McpServer): void {
  server.registerResource(
    "fares",
    "ttc://fares",
    {
      title: "TTC fares",
      description:
        "The full TTC fare table plus the 2-hour transfer rule — the get_fare tool's DTO.",
      mimeType: "application/json",
    },
    (uri): ReadResourceResult => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(selectFares()),
        },
      ],
    }),
  );
}
