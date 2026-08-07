import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { alertCategorySchema } from "../schemas/alert.js";
import { modeSchema } from "../schemas/stop.js";

export const serviceStatusArgsShape = {
  mode: modeSchema
    .optional()
    .describe("Optional mode filter: subway, streetcar, or bus."),
  route_id: z.string().optional().describe("Optional route_id filter."),
  stop_id: z.string().optional().describe("Optional stop_id filter."),
  category: alertCategorySchema
    .optional()
    .describe(
      "Optional category filter: elevator, escalator, detour, delay, no_service, planned, other.",
    ),
};

/** Wraps `get_alerts`: current service disruptions, optionally scoped. */
export function registerServiceStatus(server: McpServer): void {
  server.registerPrompt(
    "service_status",
    {
      title: "Service status",
      description:
        "Current TTC service alerts (outages, detours, delays, planned work), optionally scoped by mode/route/stop/category.",
      argsSchema: serviceStatusArgsShape,
    },
    ({ mode, route_id, stop_id, category }): GetPromptResult => {
      const filters: string[] = [];
      if (mode !== undefined) filters.push(`mode "${mode}"`);
      if (route_id !== undefined) filters.push(`route_id "${route_id}"`);
      if (stop_id !== undefined) filters.push(`stop_id "${stop_id}"`);
      if (category !== undefined) filters.push(`category "${category}"`);
      const scope =
        filters.length > 0
          ? ` filtered to ${filters.join(", ")}`
          : " across the whole system";

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Call the get_alerts tool${scope} and summarize current TTC ` +
                "service status. Group the alerts by category (elevator/escalator " +
                "outages, detours, delays, no-service, planned work, other) and " +
                "call out severity where given. If there are no alerts matching " +
                "the scope, say service looks normal.",
            },
          },
        ],
      };
    },
  );
}
