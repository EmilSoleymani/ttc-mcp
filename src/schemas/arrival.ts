import { z } from "zod";

import { toolErrorSchema } from "../errors.js";
import { stopSummarySchema } from "./stop.js";

/**
 * Why a field this arrival would normally carry was withheld (#33). The
 * project's posture is to decline rather than guess, so absence is a real
 * outcome — this names which one. See CONTEXT.md's "Real-time service
 * quality" and docs/adr/0003-schedule-adherence-identifiability.md.
 */
export const arrivalUnavailableReasonSchema = z.enum([
  // The stop-sequence pattern match declined to attribute a direction, so the
  // trip has no identity to borrow a headsign or a scheduled time from.
  "unmatched_trip",
  // Scheduled trips here run too close together for a prediction to be
  // attributed to any one of them; schedule adherence is not measurable.
  "frequent_service",
  // Nothing scheduled for this route and direction falls near the prediction.
  "no_scheduled_service",
]);
export type ArrivalUnavailableReason = z.infer<
  typeof arrivalUnavailableReasonSchema
>;

// docs/spec/tool-schemas.md #6. direction_id and delay_seconds are populated
// for scheduled arrivals (static trip) and for pattern-matched live arrivals
// (#33); either is omitted when it cannot be established, with the reason
// recorded in `unavailable`. The RT feed pins `directionId` to 0 on every
// trip, so emitting a 0 for an unmatched trip would be indistinguishable from
// a genuine direction 0 — absent is the only honest answer.
export const arrivalSchema = z.object({
  route_id: z.string(),
  route_short_name: z.string().optional(),
  headsign: z.string(),
  direction_id: z.number().int().optional(),
  time: z.string(),
  realtime: z.boolean(),
  source: z.enum(["predicted", "scheduled"]),
  delay_seconds: z.number().int().optional(),
  /**
   * Fields withheld from *this* arrival and why. Live arrivals only — for a
   * scheduled arrival `source`/`realtime` already explain the absence of
   * `delay_seconds`. Omitted entirely when nothing was withheld.
   */
  unavailable: z
    .array(
      z.object({
        field: z.enum(["direction_id", "delay_seconds"]),
        reason: arrivalUnavailableReasonSchema,
      }),
    )
    .optional(),
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
