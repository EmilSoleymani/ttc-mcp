import type { Client } from "@libsql/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RtClient } from "./gtfs-rt/rt-client.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources.js";
import { registerGetAlerts } from "./tools/get-alerts.js";
import { registerGetArrivals } from "./tools/get-arrivals.js";
import { registerGetFare } from "./tools/get-fare.js";
import { registerGetSchedule } from "./tools/get-schedule.js";
import { registerGetRoute } from "./tools/get-route.js";
import { registerGetStop } from "./tools/get-stop.js";
import { registerGetVehicles } from "./tools/get-vehicles.js";
import { registerListRoutes } from "./tools/list-routes.js";
import { registerPlanTrip } from "./tools/plan-trip.js";
import { registerSearchStops } from "./tools/search-stops.js";

export const SERVER_INFO = { name: "ttc-mcp", version: "0.1.0" };

/** Shared dependencies data-backed tools/resources need — the libSQL query
 * layer, and the GTFS-RT client for live-data tools/resources. */
export interface ServerDeps {
  db: Client;
  rt: RtClient;
}

/**
 * Registers every tool/resource/prompt onto a server instance.
 */
export function registerTools(server: McpServer, deps: ServerDeps): void {
  registerGetFare(server);
  registerSearchStops(server, deps);
  registerGetStop(server, deps);
  registerGetSchedule(server, deps);
  registerListRoutes(server, deps);
  registerGetRoute(server, deps);
  registerGetVehicles(server, deps);
  registerGetAlerts(server, deps);
  registerGetArrivals(server, deps);
  registerPlanTrip(server, deps);
  registerResources(server, deps);
  registerPrompts(server);
}

/**
 * Transport-agnostic server assembly: the stdio and standalone HTTP entry
 * surfaces call this and only this (stack-baseline: inherits go-planner's
 * project-architecture spec §3).
 */
export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerTools(server, deps);
  return server;
}
