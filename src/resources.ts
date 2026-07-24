import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { selectFares } from "./data/fares.js";
import { listRoutes } from "./gtfs/routes-repository.js";
import { listStops } from "./gtfs/stops-repository.js";
import type { ServerDeps } from "./server.js";

// Resource content mirrors the corresponding tool's DTO exactly, so the
// browsable Resource and the callable Tool cannot drift (tool-schemas spec:
// catalog + fares exposed as both Resources and mirror Tools).
export function registerResources(server: McpServer, deps: ServerDeps): void {
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

  server.registerResource(
    "stops",
    "ttc://stops",
    {
      title: "TTC stop catalog",
      description:
        "The full TTC stop/station catalog (StopSummary[]) — unfiltered and uncapped, unlike the search_stops tool.",
      mimeType: "application/json",
    },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await listStops(deps.db)),
        },
      ],
    }),
  );

  server.registerResource(
    "routes",
    "ttc://routes",
    {
      title: "TTC route catalog",
      description:
        "The full TTC route catalog (RouteSummary[]) — the list_routes tool's DTO, unfiltered.",
      mimeType: "application/json",
    },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await listRoutes(deps.db)),
        },
      ],
    }),
  );
}
