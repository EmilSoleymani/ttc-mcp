import { z } from "zod";

import { toolErrorSchema } from "../errors.js";
import { stopSummarySchema } from "./stop.js";

// get_schedule's per-departure entry (docs/spec/tool-schemas.md #5
// get_schedule). `platform_stop_id` is set only when the queried stop_id
// was a station aggregating child platforms.
export const scheduledDepartureSchema = z.object({
  route_id: z.string(),
  route_short_name: z.string().optional(),
  headsign: z.string(),
  direction_id: z.number().int(),
  scheduled_time: z.string(),
  platform_stop_id: z.string().optional(),
});
export type ScheduledDeparture = z.infer<typeof scheduledDepartureSchema>;

export const getScheduleInputShape = {
  stop_id: z.string().describe("The stop_id (or station id) to look up."),
  route_id: z.string().optional().describe("Optional route_id filter."),
  when: z
    .string()
    .optional()
    .describe("ISO 8601 time to start from (default: now, America/Toronto)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Max results (default 20, capped at 20)."),
};

export const getScheduleOutputShape = {
  stop: stopSummarySchema.optional(),
  departures: z.array(scheduledDepartureSchema),
  truncated: z.boolean(),
  hint: z.string().optional(),
  error: toolErrorSchema.optional(),
};
