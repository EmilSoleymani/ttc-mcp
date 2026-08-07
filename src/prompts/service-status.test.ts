import { describe, expect, it } from "vitest";

import { getPrompt } from "../tools/test-support.js";

function text(message: { content: unknown }): string {
  return (message.content as { text: string }).text;
}

describe("service_status prompt", () => {
  it("tells the client to call get_alerts with no filters system-wide", async () => {
    const result = await getPrompt("service_status", {});
    const body = text(result.messages[0]!);
    expect(body).toContain("get_alerts");
    expect(body).toContain("across the whole system");
  });

  it("mentions each provided filter", async () => {
    const result = await getPrompt("service_status", {
      mode: "subway",
      route_id: "1",
      stop_id: "9000",
      category: "delay",
    });
    const body = text(result.messages[0]!);
    expect(body).toContain('mode "subway"');
    expect(body).toContain('route_id "1"');
    expect(body).toContain('stop_id "9000"');
    expect(body).toContain('category "delay"');
  });
});
