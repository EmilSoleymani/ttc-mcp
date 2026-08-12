import { describe, expect, it } from "vitest";

import { getPrompt } from "../tools/test-support.js";

describe("nearby_stops prompt", () => {
  it("tells the client to call search_stops near the given point, then get_stop", async () => {
    const messages = await getPrompt("nearby_stops", {
      lat: "43.6532",
      lon: "-79.3832",
    });
    const body = messages[0]?.text ?? "";
    expect(body).toContain("search_stops");
    expect(body).toContain("lat: 43.6532");
    expect(body).toContain("lon: -79.3832");
    expect(body).toContain("get_stop");
    expect(body).not.toContain("radius_m");
  });

  it("mentions radius_m and mode when given", async () => {
    const messages = await getPrompt("nearby_stops", {
      lat: "43.65",
      lon: "-79.38",
      radius_m: "1000",
      mode: "streetcar",
    });
    const body = messages[0]?.text ?? "";
    expect(body).toContain("radius_m 1000");
    expect(body).toContain('mode "streetcar"');
  });
});
