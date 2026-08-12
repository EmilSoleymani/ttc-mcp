import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { type ToolError, toolError } from "../errors.js";
import { planTrip, resolveBothEndpoints } from "../gtfs/routing/index.js";
import type { Candidates, Itinerary } from "../schemas/itinerary.js";
import {
  MAX_TRANSFERS,
  planTripInputShape,
  planTripOutputShape,
} from "../schemas/itinerary.js";
import type { StopSummary } from "../schemas/stop.js";
import type { ServerDeps } from "../server.js";

const DEFAULT_MAX_ITINERARIES = 3;

interface PlanTripDto {
  from: StopSummary | null;
  to: StopSummary | null;
  itineraries: Itinerary[];
  candidates?: Candidates;
  error?: ToolError;
}

function result(dto: PlanTripDto, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(dto) }],
    structuredContent: dto as unknown as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

export function registerPlanTrip(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "plan_trip",
    {
      title: "Plan a multi-modal TTC trip",
      description:
        "Plan a bus/streetcar/subway journey with transfers between two endpoints (each a stop_id, place name, or {lat, lon}). Depart-after by default; set arrive_by to plan backward from `when` (emulated). Returns up to `max_itineraries` distinct options. An ambiguous name returns `candidates` (success) to disambiguate. Times are absolute ISO 8601 (America/Toronto); scheduled, not live.",
      inputSchema: planTripInputShape,
      outputSchema: planTripOutputShape,
    },
    async ({
      from,
      to,
      when,
      arrive_by,
      max_transfers,
      max_itineraries,
      modes,
    }): Promise<CallToolResult> => {
      const both = await resolveBothEndpoints(deps.db, from, to);
      if (both.kind === "candidates") {
        return result({
          from: null,
          to: null,
          itineraries: [],
          candidates: both.candidates,
        });
      }
      if (both.kind === "error") {
        return result(
          { from: null, to: null, itineraries: [], error: both.error },
          true,
        );
      }

      let depart = new Date();
      if (when !== undefined) {
        depart = new Date(when);
        if (Number.isNaN(depart.getTime())) {
          return result(
            {
              from: both.from,
              to: both.to,
              itineraries: [],
              error: toolError(
                "invalid_argument",
                `when must be a valid ISO 8601 timestamp, got "${when}".`,
              ),
            },
            true,
          );
        }
      }

      const itineraries = await planTrip(deps.db, {
        from: both.from,
        to: both.to,
        fromAccess: both.fromAccess,
        toAccess: both.toAccess,
        when: depart,
        arriveBy: arrive_by === true,
        maxTransfers: max_transfers ?? MAX_TRANSFERS,
        maxItineraries: max_itineraries ?? DEFAULT_MAX_ITINERARIES,
        ...(modes !== undefined ? { modes } : {}),
      });

      if (itineraries.length === 0) {
        // Success-shaped: the endpoints resolved but nothing was reachable
        // (for arrive_by, nothing arrives by the target within the window).
        return result({
          from: both.from,
          to: both.to,
          itineraries: [],
          error: toolError(
            "no_results",
            arrive_by === true
              ? "No itinerary arrives by the requested time."
              : "No itinerary found within the search window.",
          ),
        });
      }

      return result({ from: both.from, to: both.to, itineraries });
    },
  );
}
