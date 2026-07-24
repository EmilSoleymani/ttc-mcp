import { z } from "zod";

import { toolErrorSchema } from "../errors.js";
import { modeSchema, routeSummarySchema, stopSummarySchema } from "./stop.js";

export const routeDirectionSchema = z.object({
  direction_id: z.number().int(),
  headsign: z.string(),
});
export type RouteDirection = z.infer<typeof routeDirectionSchema>;

export const routeDirectionStopsSchema = z.object({
  direction_id: z.number().int(),
  stops: z.array(stopSummarySchema),
});
export type RouteDirectionStops = z.infer<typeof routeDirectionStopsSchema>;

// get_route's result: the route plus its directions (one representative
// headsign per direction_id) and stops per direction, capped with
// `truncated` (docs/spec/tool-schemas.md #4 get_route).
export const routeDetailSchema = routeSummarySchema.extend({
  directions: z.array(routeDirectionSchema),
  stops_by_direction: z.array(routeDirectionStopsSchema).optional(),
  truncated: z.boolean(),
});
export type RouteDetail = z.infer<typeof routeDetailSchema>;

export const listRoutesInputShape = {
  mode: modeSchema.optional().describe("Optional mode filter."),
};

export const listRoutesOutputShape = {
  routes: z.array(routeSummarySchema),
};

export const getRouteInputShape = {
  route_id: z.string().describe("The route_id to look up."),
};

export const getRouteOutputShape = {
  route: routeDetailSchema.optional(),
  error: toolErrorSchema.optional(),
};
