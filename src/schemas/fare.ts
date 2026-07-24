import { z } from "zod";

export const fareCategorySchema = z.enum(["adult", "senior", "youth", "child"]);
export const fareTypeSchema = z.enum(["presto", "cash", "day_pass", "monthly"]);

export type FareCategory = z.infer<typeof fareCategorySchema>;
export type FareType = z.infer<typeof fareTypeSchema>;

export const getFareInputShape = {
  category: fareCategorySchema
    .optional()
    .describe("Optional rider category filter (adult, senior, youth, child)."),
  fare_type: fareTypeSchema
    .optional()
    .describe(
      "Optional payment-type filter (presto, cash, day_pass, monthly).",
    ),
};

export const fareSchema = z.object({
  category: fareCategorySchema,
  fare_type: fareTypeSchema,
  price: z.number(),
  currency: z.literal("CAD"),
});

export const transferSchema = z.object({
  window_minutes: z.number(),
  rules: z.string(),
});

export const fareOutputSchema = z.object({
  fares: z.array(fareSchema),
  transfer: transferSchema,
  notes: z.string(),
  source_url: z.string(),
});

export type Fare = z.infer<typeof fareSchema>;
export type FareResult = z.infer<typeof fareOutputSchema>;

export const fareOutputShape = fareOutputSchema.shape;
