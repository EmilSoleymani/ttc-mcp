import { describe, expect, it } from "vitest";

import { getPrompt } from "../tools/test-support.js";

describe("plan_a_trip prompt", () => {
  it("renders a guided depart-after message", async () => {
    const messages = await getPrompt("plan_a_trip", {
      from: "Union Station",
      to: "Kipling",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    const text = messages[0]?.text ?? "";
    expect(text).toContain('from "Union Station" to "Kipling"');
    expect(text).toContain("departing now");
    expect(text).toContain("plan_trip");
    expect(text).toContain("from=Union Station, to=Kipling");
    // Teaches the candidates loop and the caveats.
    expect(text).toContain("candidates");
    expect(text).toContain("get_fare");
    expect(text).toContain("scheduled times, not live");
  });

  it("renders an arrive_by message when arrive_by='true'", async () => {
    const messages = await getPrompt("plan_a_trip", {
      from: "A",
      to: "B",
      when: "2026-08-04T09:00:00-04:00",
      arrive_by: "true",
    });
    const text = messages[0]?.text ?? "";
    expect(text).toContain("arriving by 2026-08-04T09:00:00-04:00");
    expect(text).toContain("arrive_by=true");
    expect(text).toContain("when=2026-08-04T09:00:00-04:00");
  });
});
