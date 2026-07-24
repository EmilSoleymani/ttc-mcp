const GTFS_TIME_RE = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/;

/**
 * Parses a GTFS `HH:MM:SS` time-of-day into integer seconds-since-midnight.
 * GTFS hours may exceed 24 for service that runs past midnight (e.g.
 * `25:30:00` for 1:30 AM the next service day) — that is preserved as-is
 * rather than wrapped, so ordering and "past midnight" detection stay exact.
 */
export function parseGtfsTime(value: string): number {
  const match = GTFS_TIME_RE.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid GTFS time: ${JSON.stringify(value)}`);
  }
  const [, hh, mm, ss] = match as unknown as [string, string, string, string];
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}
