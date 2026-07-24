// Pure field transforms for GTFS CSV rows. Kept separate from the ingest
// orchestration so the tricky parsing (single-digit and past-24h GTFS times)
// is unit-testable in isolation.

/** Parses an integer-ish GTFS field; blank/undefined/non-numeric → null. */
export function toInt(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Parses a float GTFS field (lat/lon); blank/undefined/non-numeric → null. */
export function toReal(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Converts a GTFS `H:MM:SS` / `HH:MM:SS` clock string to integer
 * seconds-since-service-day-start. Handles single-digit hours (TTC emits
 * `6:32:37`) and past-midnight hours > 24 (`25:10:00` → 90600), which is why
 * this splits on ":" rather than slicing fixed offsets.
 */
export function gtfsTimeToSeconds(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) {
    return null;
  }
  return h * 3600 + m * 60 + s;
}
