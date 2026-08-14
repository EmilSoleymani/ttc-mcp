import { describe, expect, it } from "vitest";

import { getPrompt } from "../tools/test-support.js";

describe("check_my_commute prompt", () => {
  it("tells the client to call get_arrivals with the given stop_id", async () => {
    const messages = await getPrompt("check_my_commute", { stop_id: "662" });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    const body = messages[0]?.text ?? "";
    expect(body).toContain("get_arrivals");
    expect(body).toContain('stop_id "662"');
    expect(body).not.toContain("route_id");
  });

  it("mentions the route_id filter when given", async () => {
    const messages = await getPrompt("check_my_commute", {
      stop_id: "662",
      route_id: "900",
    });
    const body = messages[0]?.text ?? "";
    expect(body).toContain('route_id "900"');
  });
});
