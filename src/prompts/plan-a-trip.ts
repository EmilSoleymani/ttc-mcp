import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// The `plan_a_trip` prompt (reserved in ticket 005, shipped with plan_trip,
// issue #12). A guided wrapper: it doesn't just call the tool, it teaches the
// model the tool's contract — the candidates disambiguation loop, a compact
// itinerary presentation, and the flat-fare / scheduled-not-live caveats.
// Prompt arguments are string-valued (MCP), so `arrive_by` arrives as text.

export function registerPlanATrip(server: McpServer): void {
  server.registerPrompt(
    "plan_a_trip",
    {
      title: "Plan a TTC trip",
      description:
        "Plan a multi-modal TTC trip between two places and present the options.",
      argsSchema: {
        from: z.string().describe("Origin: a stop name, stop_id, or place."),
        to: z.string().describe("Destination: a stop name, stop_id, or place."),
        when: z
          .string()
          .optional()
          .describe("Time, ISO 8601 (default: now, America/Toronto)."),
        arrive_by: z
          .string()
          .optional()
          .describe(
            "'true' to arrive by `when` instead of departing after it.",
          ),
      },
    },
    ({ from, to, when, arrive_by }) => {
      const arriveBy = arrive_by?.toLowerCase() === "true";
      const timePhrase = when
        ? `${arriveBy ? "arriving by" : "departing around"} ${when}`
        : "departing now";

      const callHint = [
        `from=${from}`,
        `to=${to}`,
        ...(when ? [`when=${when}`] : []),
        ...(arriveBy ? ["arrive_by=true"] : []),
      ].join(", ");

      const text = [
        `Plan a TTC trip from "${from}" to "${to}", ${timePhrase}.`,
        ``,
        `Call the \`plan_trip\` tool with ${callHint}.`,
        `- If it returns \`candidates\`, that endpoint was ambiguous — show me the`,
        `  matches and ask which one, then call \`plan_trip\` again using the chosen`,
        `  stop_id.`,
        `- Otherwise summarize each itinerary: overall depart → arrive time, total`,
        `  duration, and number of transfers; then each leg — for a transit leg the`,
        `  mode + route and where to board/alight, for a walk its duration.`,
        `- Note that a flat TTC fare applies (use \`get_fare\` for exact prices) and`,
        `  that these are scheduled times, not live predictions.`,
      ].join("\n");

      return {
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    },
  );
}
