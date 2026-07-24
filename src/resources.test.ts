import { describe, expect, it } from "vitest";

import type { FareResult } from "./schemas/fare.js";
import { readResource } from "./tools/test-support.js";

describe("ttc://fares resource", () => {
  it("returns the same fare DTO the get_fare tool does", async () => {
    const contents = await readResource("ttc://fares");
    expect(contents).toHaveLength(1);

    const entry = contents[0]!;
    expect(entry.uri).toBe("ttc://fares");
    expect(entry.mimeType).toBe("application/json");

    const dto = JSON.parse(entry.text) as FareResult;
    expect(dto.transfer.window_minutes).toBe(120);
    expect(dto.fares.length).toBeGreaterThan(0);
  });
});
