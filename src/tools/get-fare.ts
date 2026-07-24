import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { selectFares } from "../data/fares.js";
import { fareOutputShape, getFareInputShape } from "../schemas/fare.js";

export function registerGetFare(server: McpServer): void {
  server.registerTool(
    "get_fare",
    {
      title: "Get TTC fares",
      description:
        "The current TTC fare table (adult/senior/youth/child by payment type) plus the 2-hour transfer rule. Fares are a flat, hand-maintained table — TTC publishes no machine-readable fare data. Optionally filter by category and/or fare_type.",
      inputSchema: getFareInputShape,
      outputSchema: fareOutputShape,
    },
    ({ category, fare_type }): CallToolResult => {
      const dto = selectFares(category, fare_type);
      return {
        content: [{ type: "text", text: JSON.stringify(dto) }],
        structuredContent: dto,
      };
    },
  );
}
