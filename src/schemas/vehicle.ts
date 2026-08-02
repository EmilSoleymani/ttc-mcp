import { z } from "zod";

import { toolErrorSchema } from "../errors.js";

// Vehicle DTO finalized against the decoded VehiclePosition protobuf
// (docs/spec/realtime-integration.md #3 "Feed -> tool mapping",
// docs/spec/tool-schemas.md #7 get_vehicles).
export const vehicleSchema = z.object({
  vehicle_id: z.string(),
  lat: z.number(),
  lon: z.number(),
  bearing: z.number().optional(),
  route_id: z.string(),
  trip_id: z.string().optional(),
  headsign: z.string().optional(),
  occupancy_status: z.string().optional(),
  timestamp: z.string(),
});
export type Vehicle = z.infer<typeof vehicleSchema>;

export const getVehiclesInputShape = {
  route_id: z.string().describe("The route_id to filter live vehicles by."),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Max results (default 50, capped at 50)."),
};

export const getVehiclesOutputShape = {
  route_id: z.string(),
  vehicles: z.array(vehicleSchema),
  realtime_available: z.boolean(),
  truncated: z.boolean(),
  note: z.string().optional(),
  error: toolErrorSchema.optional(),
};
