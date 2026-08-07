import { describe, expect, it } from "vitest";

import { getPrompt } from "../tools/test-support.js";

function text(message: { content: unknown }): string {
  return (message.content as { text: string }).text;
}

describe("nearby_stops prompt", () => {
  it("tells the client to call search_stops near the given point, then get_stop", async () => {
    const result = await getPrompt("nearby_stops", {
      lat: "43.6532",
      lon: "-79.3832",
    });
    const body = text(result.messages[0]!);
    expect(body).toContain("search_stops");
    expect(body).toContain("lat: 43.6532");
    expect(body).toContain("lon: -79.3832");
    expect(body).toContain("get_stop");
    expect(body).not.toContain("radius_m");
  });

  it("mentions radius_m and mode when given", async () => {
    const result = await getPrompt("nearby_stops", {
      lat: "43.65",
      lon: "-79.38",
      radius_m: "1000",
      mode: "streetcar",
    });
    const body = text(result.messages[0]!);
    expect(body).toContain("radius_m 1000");
    expect(body).toContain('mode "streetcar"');
  });
});
