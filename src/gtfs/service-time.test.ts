import { describe, expect, it } from "vitest";

import {
  absoluteTimeFor,
  addDays,
  secondsSinceServiceMidnight,
  serviceDateAt,
  toIsoWithTorontoOffset,
  toYyyymmdd,
  weekdayOf,
} from "./service-time.js";

describe("service-time", () => {
  it("formats an EDT (summer) instant with a -04:00 offset", () => {
    expect(toIsoWithTorontoOffset(new Date("2026-07-24T18:35:00Z"))).toBe(
      "2026-07-24T14:35:00-04:00",
    );
  });

  it("formats an EST (winter) instant with a -05:00 offset", () => {
    expect(toIsoWithTorontoOffset(new Date("2026-01-15T18:35:00Z"))).toBe(
      "2026-01-15T13:35:00-05:00",
    );
  });

  it("resolves a past-24:00:00 GTFS time to the correct next-day instant", () => {
    // 25:10:00 (90600s) on the 2026-07-24 service date is 2026-07-25 01:10
    // local, not 2026-07-24 25:10 (which doesn't exist as a clock time).
    const absolute = absoluteTimeFor({ year: 2026, month: 7, day: 24 }, 90_600);
    expect(toIsoWithTorontoOffset(absolute)).toBe("2026-07-25T01:10:00-04:00");
  });

  it("resolves an ordinary same-day GTFS time", () => {
    const absolute = absoluteTimeFor({ year: 2026, month: 7, day: 24 }, 21_600);
    expect(toIsoWithTorontoOffset(absolute)).toBe("2026-07-24T06:00:00-04:00");
  });

  it("finds the America/Toronto calendar date of a UTC instant near midnight", () => {
    // 03:59 UTC on 2026-07-24 is still 2026-07-23 23:59 in Toronto (EDT).
    expect(serviceDateAt(new Date("2026-07-24T03:59:00Z"))).toEqual({
      year: 2026,
      month: 7,
      day: 23,
    });
  });

  it("adds and subtracts calendar days across a month boundary", () => {
    expect(addDays({ year: 2026, month: 7, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 8,
      day: 1,
    });
    expect(addDays({ year: 2026, month: 8, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 7,
      day: 31,
    });
  });

  it("converts a service date to the GTFS yyyymmdd integer", () => {
    expect(toYyyymmdd({ year: 2026, month: 7, day: 24 })).toBe(20_260_724);
  });

  it("reports the weekday matching calendar's column convention (0=Sunday)", () => {
    // 2026-07-24 is a Friday.
    expect(weekdayOf({ year: 2026, month: 7, day: 24 })).toBe(5);
  });

  describe("secondsSinceServiceMidnight", () => {
    it("returns seconds since Toronto service-midnight for a same-day instant", () => {
      // 15:00 EDT is 54000s after 00:00 EDT on the same service date.
      const s = secondsSinceServiceMidnight(
        { year: 2026, month: 7, day: 24 },
        new Date("2026-07-24T15:00:00-04:00"),
      );
      expect(s).toBe(54000);
    });

    it("is negative when the instant precedes the service date's midnight (next-day window)", () => {
      // Service date 07-25, instant on 07-24 → before that midnight.
      const s = secondsSinceServiceMidnight(
        { year: 2026, month: 7, day: 25 },
        new Date("2026-07-24T15:00:00-04:00"),
      );
      expect(s).toBeLessThan(0);
    });

    it("exceeds 86400 for a prior service date's post-midnight window", () => {
      // Service date 07-23, instant 07-24T15:00 → 39h = 140400s.
      const s = secondsSinceServiceMidnight(
        { year: 2026, month: 7, day: 23 },
        new Date("2026-07-24T15:00:00-04:00"),
      );
      expect(s).toBe(140400);
    });
  });
});
