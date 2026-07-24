import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerResources } from "./resources.js";
import { registerGetFare } from "./tools/get-fare.js";

export const SERVER_INFO = { name: "ttc-mcp", version: "0.1.0" };

/**
 * Registers every tool/resource/prompt onto a server instance. As later slices
 * add data-backed tools this will take a `deps` argument (the libSQL query
 * layer + GTFS-RT client); the static get_fare tool needs none.
 */
export function registerTools(server: McpServer): void {
  registerGetFare(server);
  registerResources(server);
}

/**
 * Transport-agnostic server assembly: the stdio and standalone HTTP entry
 * surfaces call this and only this (stack-baseline: inherits go-planner's
 * project-architecture spec §3).
 */
export function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerTools(server);
  return server;
}
