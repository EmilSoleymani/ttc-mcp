import { describe, expect, it } from "vitest";

import type { FareResult } from "../schemas/fare.js";
import { callTool } from "./test-support.js";

describe("get_fare", () => {
  it("returns the full fare table with the transfer rule as structuredContent", async () => {
    const result = await callTool("get_fare", {});
    expect(result.isError).toBe(false);

    const dto = result.structuredContent as FareResult;
    expect(dto.transfer.window_minutes).toBe(120);
    expect(dto.source_url).toContain("ttc.ca");
    expect(dto.fares).toEqual(
      expect.arrayContaining([
        {
          category: "adult",
          fare_type: "presto",
          price: 3.35,
          currency: "CAD",
        },
      ]),
    );
    // Every category is represented in the unfiltered table.
    expect(new Set(dto.fares.map((f) => f.category))).toEqual(
      new Set(["adult", "senior", "youth", "child"]),
    );
  });

  it("filters by rider category", async () => {
    const result = await callTool("get_fare", { category: "senior" });
    const dto = result.structuredContent as FareResult;
    expect(dto.fares.length).toBeGreaterThan(0);
    expect(dto.fares.every((f) => f.category === "senior")).toBe(true);
  });

  it("filters by fare_type", async () => {
    const result = await callTool("get_fare", { fare_type: "monthly" });
    const dto = result.structuredContent as FareResult;
    expect(dto.fares.length).toBeGreaterThan(0);
    expect(dto.fares.every((f) => f.fare_type === "monthly")).toBe(true);
  });

  it("rejects an unknown category at the schema boundary", async () => {
    const result = await callTool("get_fare", { category: "corporate" });
    expect(result.isError).toBe(true);
  });
});
