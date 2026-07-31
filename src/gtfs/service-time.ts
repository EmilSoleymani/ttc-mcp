// America/Toronto conversions for GTFS service-day resolution and the
// absolute-ISO-8601-with-offset time convention (docs/spec/tool-schemas.md).
// No tz-database dependency: uses the standard "format, diff, correct" trick
// via Intl, which the Node runtime's ICU data already carries.

const TORONTO_TZ = "America/Toronto";

export interface ServiceDate {
  year: number;
  month: number;
  day: number;
}

interface WallClock extends ServiceDate {
  hour: number;
  minute: number;
  second: number;
}

const TORONTO_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: TORONTO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function wallClockAt(instant: Date): WallClock {
  const parts = TORONTO_FORMATTER.formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The America/Toronto calendar date containing the given instant. */
export function serviceDateAt(instant: Date): ServiceDate {
  const { year, month, day } = wallClockAt(instant);
  return { year, month, day };
}

export function addDays(date: ServiceDate, delta: number): ServiceDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  utc.setUTCDate(utc.getUTCDate() + delta);
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

/** yyyymmdd integer matching calendar.start_date/end_date/calendar_dates.date. */
export function toYyyymmdd(date: ServiceDate): number {
  return date.year * 10000 + date.month * 100 + date.day;
}

/** 0 (Sunday) .. 6 (Saturday), matching calendar's weekday columns. */
export function weekdayOf(date: ServiceDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

// The instant of Toronto local midnight for a service date: guess the
// instant by treating the wall-clock as if it were UTC, then look up
// Toronto's actual offset at that guess and correct for it.
function midnightInstant(date: ServiceDate): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0);
  const guessAsToronto = wallClockAt(new Date(guess));
  const guessAsTorontoUtcMs = Date.UTC(
    guessAsToronto.year,
    guessAsToronto.month - 1,
    guessAsToronto.day,
    guessAsToronto.hour,
    guessAsToronto.minute,
    guessAsToronto.second,
  );
  const offsetMs = guessAsTorontoUtcMs - guess;
  return new Date(guess - offsetMs);
}

/** Seconds after `date`'s America/Toronto service-midnight at which a GTFS
 * `dep` (seconds-since-midnight) is still at/after `instant`. Floored — a
 * safe lower bound to pair with an exact JS `absolute >= when` filter.
 * Negative when `instant` precedes the date's midnight (the +1-day window). */
export function secondsSinceServiceMidnight(
  date: ServiceDate,
  instant: Date,
): number {
  return Math.floor((instant.getTime() - midnightInstant(date).getTime()) / 1000);
}

/** The UTC instant for a GTFS seconds-since-midnight time on a service date
 * — past-24:00:00 GTFS times (e.g. 25:10:00) resolve to the correct
 * next-day instant, since they're just added past the date's midnight. */
export function absoluteTimeFor(
  date: ServiceDate,
  secondsSinceMidnight: number,
): Date {
  return new Date(
    midnightInstant(date).getTime() + secondsSinceMidnight * 1000,
  );
}

/** Formats a UTC instant as absolute ISO 8601 with its America/Toronto
 * offset, e.g. "2026-07-24T14:35:00-04:00". */
export function toIsoWithTorontoOffset(instant: Date): string {
  const local = wallClockAt(instant);
  const localAsUtcMs = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const offsetMinutes = Math.round((localAsUtcMs - instant.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${String(local.year).padStart(4, "0")}-${pad(local.month)}-${pad(local.day)}` +
    `T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
