import { z } from "zod";

import { toolErrorSchema } from "../errors.js";
import { modeSchema, stopSummarySchema } from "./stop.js";

// plan_trip DTOs (docs/spec/plan-trip.md, ADR 0002,
// docs/superpowers/specs/2026-08-04-plan-trip-design.md). All times are
// absolute ISO 8601 America/Toronto; ids are strings (numeric in the DB).

// A leg the rider spends aboard one vehicle on a single pattern.
export const transitLegSchema = z.object({
  type: z.literal("transit"),
  mode: modeSchema,
  route_id: z.string(),
  route_short_name: z.string().optional(),
  headsign: z.string(),
  board: stopSummarySchema,
  alight: stopSummarySchema,
  board_time: z.string(),
  alight_time: z.string(),
  num_stops: z.number().int().nonnegative(),
});
export type TransitLeg = z.infer<typeof transitLegSchema>;

// A walk (footpath) between two stops — access, egress, or an interchange.
export const transferLegSchema = z.object({
  type: z.literal("transfer"),
  from: stopSummarySchema,
  to: stopSummarySchema,
  walk_seconds: z.number().int().nonnegative(),
});
export type TransferLeg = z.infer<typeof transferLegSchema>;

export const legSchema = z.discriminatedUnion("type", [
  transitLegSchema,
  transferLegSchema,
]);
export type Leg = z.infer<typeof legSchema>;

export const itinerarySchema = z.object({
  depart_time: z.string(),
  arrive_time: z.string(),
  duration_seconds: z.number().int().nonnegative(),
  transfers: z.number().int().nonnegative(),
  legs: z.array(legSchema),
});
export type Itinerary = z.infer<typeof itinerarySchema>;

// An ambiguous endpoint is a *success*: the matching stops come back for the
// caller to disambiguate. `endpoint` says which side (plan_trip has two) —
// ADR 0002 (top-level, not nested in `error`).
export const candidatesSchema = z.object({
  endpoint: z.enum(["from", "to"]),
  matches: z.array(stopSummarySchema),
});
export type Candidates = z.infer<typeof candidatesSchema>;

// An endpoint: a stop_id or place name (string) or a coordinate.
export const endpointSchema = z.union([
  z.string().min(1),
  z.object({ lat: z.number(), lon: z.number() }),
]);
export type Endpoint = z.infer<typeof endpointSchema>;

export const MAX_TRANSFERS = 3;

export const planTripInputShape = {
  from: endpointSchema.describe(
    "Origin: a stop_id, a place name, or {lat, lon}.",
  ),
  to: endpointSchema.describe(
    "Destination: a stop_id, a place name, or {lat, lon}.",
  ),
  when: z
    .string()
    .optional()
    .describe("ISO 8601 time (default: now, America/Toronto)."),
  arrive_by: z
    .boolean()
    .optional()
    .describe(
      "Arrive by `when` instead of depart after it (emulated). Default false.",
    ),
  max_transfers: z
    .number()
    .int()
    .min(0)
    .max(MAX_TRANSFERS)
    .optional()
    .describe("Max transfers (default 3, hard cap 3)."),
  modes: z
    .array(modeSchema)
    .optional()
    .describe(
      "Restrict to these modes (subway|streetcar|bus). Omit or pass [] for no restriction (all modes).",
    ),
  max_itineraries: z
    .number()
    .int()
    .positive()
    .max(5)
    .optional()
    .describe("Max distinct itineraries to return (default 3)."),
};

export const planTripOutputShape = {
  // null when that endpoint was ambiguous (its matches are in `candidates`).
  from: stopSummarySchema.nullable(),
  to: stopSummarySchema.nullable(),
  itineraries: z.array(itinerarySchema),
  candidates: candidatesSchema.optional(),
  error: toolErrorSchema.optional(),
};
