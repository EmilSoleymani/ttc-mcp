import { describe, expect, it } from "vitest";

import { parseGtfsTime } from "./time.js";

describe("parseGtfsTime", () => {
  it("parses an ordinary time-of-day", () => {
    expect(parseGtfsTime("08:05:00")).toBe(8 * 3600 + 5 * 60);
  });

  it("parses midnight", () => {
    expect(parseGtfsTime("00:00:00")).toBe(0);
  });

  it("parses GTFS's past-midnight hours (>24) without wrapping", () => {
    expect(parseGtfsTime("25:10:00")).toBe(25 * 3600 + 10 * 60);
    expect(parseGtfsTime("27:00:00")).toBe(27 * 3600);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseGtfsTime(" 08:05:00 ")).toBe(8 * 3600 + 5 * 60);
  });

  it("rejects malformed input", () => {
    expect(() => parseGtfsTime("8:5:0")).toThrow();
    expect(() => parseGtfsTime("not-a-time")).toThrow();
    expect(() => parseGtfsTime("")).toThrow();
  });
});
