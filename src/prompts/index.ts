import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCheckMyCommute } from "./check-my-commute.js";
import { registerNearbyStops } from "./nearby-stops.js";
import { registerPlanATrip } from "./plan-a-trip.js";
import { registerServiceStatus } from "./service-status.js";

/** The v1 prompt templates: thin wrappers that tell the client which
 * existing tool(s) to call and how to summarize the result. None of these
 * touch the db/RT client directly — the calling client executes the tools. */
export function registerPrompts(server: McpServer): void {
  registerCheckMyCommute(server);
  registerServiceStatus(server);
  registerNearbyStops(server);
  registerPlanATrip(server);
}
