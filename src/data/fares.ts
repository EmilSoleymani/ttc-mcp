import type {
  Fare,
  FareCategory,
  FareResult,
  FareType,
} from "../schemas/fare.js";

// Hand-maintained TTC fare table. TTC publishes NO machine-readable fare data
// (no fare_attributes.txt/fare_rules.txt in the GTFS feed — ticket 001), so
// these values are curated by hand and must be reviewed against the official
// fares page when TTC changes them (which is infrequent).
const FARES: readonly Fare[] = [
  { category: "adult", fare_type: "presto", price: 3.35, currency: "CAD" },
  { category: "adult", fare_type: "cash", price: 3.35, currency: "CAD" },
  { category: "adult", fare_type: "day_pass", price: 13.5, currency: "CAD" },
  { category: "adult", fare_type: "monthly", price: 156.0, currency: "CAD" },
  { category: "senior", fare_type: "presto", price: 2.3, currency: "CAD" },
  { category: "senior", fare_type: "monthly", price: 128.15, currency: "CAD" },
  { category: "youth", fare_type: "presto", price: 2.3, currency: "CAD" },
  { category: "youth", fare_type: "monthly", price: 128.15, currency: "CAD" },
  { category: "child", fare_type: "presto", price: 0.0, currency: "CAD" },
];

const TRANSFER = {
  window_minutes: 120,
  rules:
    "One fare covers unlimited transfers across subway, streetcar, and bus for 2 hours from first tap (PRESTO or contactless).",
} as const;

const SOURCE_URL = "https://www.ttc.ca/fares-and-passes";
const NOTES =
  "Hand-maintained fare table — TTC publishes no machine-readable fare data. Verify against the official fares page; TTC updates fares periodically.";

/** Returns the fare table, optionally filtered by category and/or fare_type. */
export function selectFares(
  category?: FareCategory,
  fareType?: FareType,
): FareResult {
  const fares = FARES.filter(
    (f) =>
      (category === undefined || f.category === category) &&
      (fareType === undefined || f.fare_type === fareType),
  );
  return { fares, transfer: TRANSFER, notes: NOTES, source_url: SOURCE_URL };
}
