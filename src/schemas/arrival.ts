import { z } from "zod";

import { toolErrorSchema } from "../errors.js";
import { stopSummarySchema } from "./stop.js";

// docs/spec/tool-schemas.md #6. delay_seconds is deferred to #33.
export const arrivalSchema = z.object({
  route_id: z.string(),
  route_short_name: z.string().optional(),
  headsign: z.string(),
  direction_id: z.number().int(),
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
