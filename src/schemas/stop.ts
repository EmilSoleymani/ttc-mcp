import { z } from "zod";

import { toolErrorSchema } from "../errors.js";

// Mode enum from GTFS route_type (0 streetcar, 1 subway, 3 bus) — TTC runs no
// other route_type (docs/spec/tool-schemas.md "Identity model").
export const modeSchema = z.enum(["subway", "streetcar", "bus"]);
export type Mode = z.infer<typeof modeSchema>;

export const routeSummarySchema = z.object({
  route_id: z.string(),
  route_short_name: z.string().optional(),
  route_long_name: z.string().optional(),
  mode: modeSchema,
  color: z.string().optional(),
});
export type RouteSummary = z.infer<typeof routeSummarySchema>;

// Canonical handle is the opaque stop_id (numeric string). A stop has no
// route_type of its own in GTFS — `mode` and `accessible` are derived by the
// repository, not read directly off a column.
export const stopSummarySchema = z.object({
  stop_id: z.string(),
  stop_code: z.string().optional(),
  name: z.string(),
  mode: modeSchema,
  is_station: z.boolean(),
  parent_station: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  accessible: z.boolean().optional(),
});
export type StopSummary = z.infer<typeof stopSummarySchema>;

// get_stop's result: the stop plus child platforms (for a station) and the
// routes serving it, aggregated across platforms for a station.
export const stopDetailSchema = stopSummarySchema.extend({
  platforms: z.array(stopSummarySchema).optional(),
  routes: z.array(routeSummarySchema),
});
export type StopDetail = z.infer<typeof stopDetailSchema>;

export const searchStopsInputShape = {
  query: z.string().min(1).optional().describe("Stop name to search for."),
  near: z
    .object({
      lat: z.number(),
      lon: z.number(),
      radius_m: z
        .number()
        .positive()
        .optional()
        .describe("Search radius in meters (default 500)."),
    })
    .optional()
    .describe("Search by proximity to a lat/lon point."),
  mode: modeSchema.optional().describe("Optional mode filter."),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Max results (default 20, capped at 20)."),
};

export const searchStopsOutputShape = {
  stops: z.array(stopSummarySchema),
  truncated: z.boolean(),
  error: toolErrorSchema.optional(),
};

export const getStopInputShape = {
  stop_id: z.string().describe("The stop_id to look up."),
};

export const getStopOutputShape = {
  stop: stopDetailSchema.optional(),
  error: toolErrorSchema.optional(),
};
