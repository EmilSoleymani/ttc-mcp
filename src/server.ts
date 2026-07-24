import type { Client } from "@libsql/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RtClient } from "./gtfs-rt/rt-client.js";
import { registerResources } from "./resources.js";
import { registerGetFare } from "./tools/get-fare.js";
import { registerGetRoute } from "./tools/get-route.js";
import { registerGetStop } from "./tools/get-stop.js";
import { registerGetVehicles } from "./tools/get-vehicles.js";
import { registerListRoutes } from "./tools/list-routes.js";
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
  registerListRoutes(server, deps);
  registerGetRoute(server, deps);
  registerGetVehicles(server, deps);
  registerResources(server, deps);
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
