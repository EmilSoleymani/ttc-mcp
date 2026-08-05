import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const checkMyCommuteArgsShape = {
  stop_id: z
    .string()
    .describe("The stop_id (or station id) to check arrivals for."),
  route_id: z
    .string()
    .optional()
    .describe("Optional route_id to narrow to a single route."),
};

/** Wraps `get_arrivals`: next arrivals at a stop, live where TTC publishes it. */
export function registerCheckMyCommute(server: McpServer): void {
  server.registerPrompt(
    "check_my_commute",
    {
      title: "Check my commute",
      description:
        "Next arrivals at a stop_id, live where available (bus/streetcar) and scheduled otherwise (subway).",
      argsSchema: checkMyCommuteArgsShape,
    },
    ({ stop_id, route_id }): GetPromptResult => {
      const routeClause = route_id ? ` filtered to route_id "${route_id}"` : "";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Call the get_arrivals tool for stop_id "${stop_id}"${routeClause} ` +
                "and tell me what's coming. For each arrival, give the route, " +
                "headsign/direction, and time. Say clearly whether the times are " +
                "live predictions or the scheduled fallback (realtime_available), " +
                "and call out any delay_seconds if present. If nothing is coming " +
                "soon, say so plainly.",
            },
          },
        ],
      };
    },
  );
}
