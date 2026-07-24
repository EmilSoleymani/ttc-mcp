import { describe, expect, it } from "vitest";

import { gtfsTimeToSeconds, toInt, toReal } from "./transform.js";

describe("gtfsTimeToSeconds", () => {
  it("parses single-digit hours (TTC emits 6:32:37)", () => {
    expect(gtfsTimeToSeconds("6:32:37")).toBe(6 * 3600 + 32 * 60 + 37);
  });

  it("parses two-digit hours", () => {
    expect(gtfsTimeToSeconds("06:32:37")).toBe(23557);
  });

  it("handles past-midnight hours > 24", () => {
    expect(gtfsTimeToSeconds("25:10:00")).toBe(25 * 3600 + 10 * 60);
  });

  it("treats 24:00:00 as end of service day", () => {
    expect(gtfsTimeToSeconds("24:00:00")).toBe(86400);
  });

  it("returns null for blank, undefined, or malformed input", () => {
    expect(gtfsTimeToSeconds("")).toBeNull();
    expect(gtfsTimeToSeconds(undefined)).toBeNull();
    expect(gtfsTimeToSeconds("12:30")).toBeNull();
    expect(gtfsTimeToSeconds("ab:cd:ef")).toBeNull();
  });
});

describe("toInt", () => {
  it("parses integers and nulls blanks/non-numeric", () => {
    expect(toInt("50658032")).toBe(50658032);
    expect(toInt("0")).toBe(0);
    expect(toInt("")).toBeNull();
    expect(toInt(undefined)).toBeNull();
    expect(toInt("abc")).toBeNull();
  });
});

describe("toReal", () => {
  it("parses floats and nulls blanks", () => {
    expect(toReal("43.714379")).toBeCloseTo(43.714379);
    expect(toReal("-79.260939")).toBeCloseTo(-79.260939);
    expect(toReal("")).toBeNull();
    expect(toReal(undefined)).toBeNull();
  });
});
