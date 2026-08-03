import { z } from "zod";

import { toolErrorSchema } from "../errors.js";
import { modeSchema } from "./stop.js";

// Raw GTFS-RT Alert.Cause/Effect/SeverityLevel enum names, lower-cased
// (docs/spec/tool-schemas.md #8 get_alerts).
export const alertCauseSchema = z.enum([
  "unknown_cause",
  "other_cause",
  "technical_problem",
  "strike",
  "demonstration",
  "accident",
  "holiday",
  "weather",
  "maintenance",
  "construction",
  "police_activity",
  "medical_emergency",
  "special_event",
]);
export type AlertCause = z.infer<typeof alertCauseSchema>;

export const alertEffectSchema = z.enum([
  "no_service",
  "reduced_service",
  "significant_delays",
  "detour",
  "additional_service",
  "modified_service",
  "other_effect",
  "unknown_effect",
  "stop_moved",
  "no_effect",
  "accessibility_issue",
]);
export type AlertEffect = z.infer<typeof alertEffectSchema>;

export const alertSeveritySchema = z.enum([
  "unknown_severity",
  "info",
  "warning",
  "severe",
]);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

// Derived (not a raw GTFS-RT field) from effect + header/description text
// (docs/spec/realtime-integration.md #3 "Alerts -> get_alerts"). `other` is a
// neutral catch-all for alerts whose effect+text give no confident signal
// (e.g. a generic OTHER_EFFECT/UNKNOWN_EFFECT/unset fare or info notice) —
// so those aren't mislabelled as a concrete `detour`.
export const alertCategorySchema = z.enum([
  "elevator",
  "escalator",
  "detour",
  "delay",
  "no_service",
  "planned",
  "other",
]);
export type AlertCategory = z.infer<typeof alertCategorySchema>;

export const alertActivePeriodSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
});
export type AlertActivePeriod = z.infer<typeof alertActivePeriodSchema>;

export const alertInformedSchema = z.object({
  routes: z.array(z.string()).optional(),
  stops: z.array(z.string()).optional(),
  modes: z.array(modeSchema).optional(),
});
export type AlertInformed = z.infer<typeof alertInformedSchema>;

// Alert DTO finalized against the decoded Alert protobuf
// (docs/spec/tool-schemas.md #8 get_alerts).
export const alertSchema = z.object({
  id: z.string(),
  header: z.string(),
  description: z.string().optional(),
  severity: alertSeveritySchema.optional(),
  cause: alertCauseSchema.optional(),
  effect: alertEffectSchema.optional(),
  category: alertCategorySchema,
  informed: alertInformedSchema,
  active_period: z.array(alertActivePeriodSchema).optional(),
  url: z.string().optional(),
});
export type Alert = z.infer<typeof alertSchema>;

export const getAlertsInputShape = {
  mode: modeSchema.optional().describe("Filter to alerts informing this mode."),
  route_id: z
    .string()
    .optional()
    .describe("Filter to alerts informing this route_id."),
  stop_id: z
    .string()
    .optional()
    .describe("Filter to alerts informing this stop_id."),
  category: alertCategorySchema
    .optional()
    .describe("Filter by derived category."),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Max results (default 50, capped at 50)."),
};

export const getAlertsOutputShape = {
  alerts: z.array(alertSchema),
  truncated: z.boolean(),
  error: toolErrorSchema.optional(),
};
