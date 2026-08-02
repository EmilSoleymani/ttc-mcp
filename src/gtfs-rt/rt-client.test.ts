import { describe, expect, it } from "vitest";

import { RtClient } from "./rt-client.js";
import { encodeVehiclePositionsFeed } from "./test-support.js";

function fakeFetch(onCall: () => void): typeof fetch {
  const body = encodeVehiclePositionsFeed([
    { vehicleId: "v1", routeId: "504", lat: 43.6, lon: -79.4 },
  ]);
  return () => {
    onCall();
    return Promise.resolve(new Response(body, { status: 200 }));
  };
}

describe("RtClient coalescing cache", () => {
  it("decodes at most once per TTL window across concurrent + sequential calls", async () => {
    let calls = 0;
    const client = new RtClient({
      cacheEnabled: true,
      ttlSeconds: 25,
      fetchImpl: fakeFetch(() => {
        calls++;
      }),
    });

    const [a, b] = await Promise.all([
      client.getVehiclePositions(),
      client.getVehiclePositions(),
    ]);
    const c = await client.getVehiclePositions();

    expect(calls).toBe(1);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
  });

  it("re-fetches once the TTL has elapsed", async () => {
    let calls = 0;
    const client = new RtClient({
      cacheEnabled: true,
      ttlSeconds: -1, // already expired the instant it's cached
      fetchImpl: fakeFetch(() => {
        calls++;
      }),
    });

    await client.getVehiclePositions();
    await client.getVehiclePositions();

    expect(calls).toBe(2);
  });

  it("re-fetches every call when caching is disabled", async () => {
    let calls = 0;
    const client = new RtClient({
      cacheEnabled: false,
      fetchImpl: fakeFetch(() => {
        calls++;
      }),
    });

    await client.getVehiclePositions();
    await client.getVehiclePositions();

    expect(calls).toBe(2);
  });

  it("does not cache a failed decode", async () => {
    let calls = 0;
    const client = new RtClient({
      cacheEnabled: true,
      ttlSeconds: 25,
      fetchImpl: () => {
        calls++;
        return Promise.resolve(new Response(null, { status: 500 }));
      },
      retryOptions: { retries: 0, baseDelayMs: 1 },
    });

    await expect(client.getVehiclePositions()).rejects.toThrow();
    await expect(client.getVehiclePositions()).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
