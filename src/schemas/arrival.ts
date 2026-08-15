import { z } from "zod";

import { toolErrorSchema } from "../errors.js";
import { stopSummarySchema } from "./stop.js";

// docs/spec/tool-schemas.md #6. direction_id and delay_seconds are populated
// for scheduled arrivals (static trip) and for pattern-matched live arrivals
// (#33); both are omitted for a live trip whose direction the pattern match
// declined to attribute. The RT feed pins `directionId` to 0 on every trip, so
// emitting a 0 for an unmatched trip would be indistinguishable from a genuine
// direction 0 — absent is the only honest answer.
export const arrivalSchema = z.object({
  route_id: z.string(),
  route_short_name: z.string().optional(),
  headsign: z.string(),
  direction_id: z.number().int().optional(),
  time: z.string(),
  realtime: z.boolean(),
  source: z.enum(["predicted", "scheduled"]),
  delay_seconds: z.number().int().optional(),
});
export type Arrival = z.infer<typeof arrivalSchema>;

export const getArrivalsInputShape = {
  stop_id: z.string().describe("The stop_id (or station id) to look up."),
  route_id: z.string().optional().describe("Optional route_id filter."),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Max results (default 20, capped at 20)."),
};

export const getArrivalsOutputShape = {
  stop: stopSummarySchema.optional(),
  arrivals: z.array(arrivalSchema),
  realtime_available: z.boolean(),
  truncated: z.boolean(),
  hint: z.string().optional(),
  error: toolErrorSchema.optional(),
};
