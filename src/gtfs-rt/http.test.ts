import { describe, expect, it } from "vitest";

import { fetchWithRetry } from "./http.js";

function response(status: number): Response {
  return new Response(null, { status });
}

describe("fetchWithRetry", () => {
  it("returns immediately on a 2xx response, no retry", async () => {
    let calls = 0;
    const result = await fetchWithRetry("https://example.test/feed", {
      baseDelayMs: 1,
      fetchImpl: () => {
        calls++;
        return Promise.resolve(response(200));
      },
    });
    expect(result.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("retries a persistent 5xx response up to `retries` times, then throws", async () => {
    let calls = 0;
    await expect(
      fetchWithRetry("https://example.test/feed", {
        retries: 2,
        baseDelayMs: 1,
        fetchImpl: () => {
          calls++;
          return Promise.resolve(response(503));
        },
      }),
    ).rejects.toThrow("503");
    expect(calls).toBe(3);
  });

  it("succeeds if a later attempt returns 2xx", async () => {
    let calls = 0;
    const result = await fetchWithRetry("https://example.test/feed", {
      retries: 2,
      baseDelayMs: 1,
      fetchImpl: () => {
        calls++;
        return Promise.resolve(response(calls < 2 ? 500 : 200));
      },
    });
    expect(result.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("never retries a 429", async () => {
    let calls = 0;
    const result = await fetchWithRetry("https://example.test/feed", {
      retries: 2,
      baseDelayMs: 1,
      fetchImpl: () => {
        calls++;
        return Promise.resolve(response(429));
      },
    });
    expect(result.status).toBe(429);
    expect(calls).toBe(1);
  });

  it("retries a network error and eventually throws it", async () => {
    let calls = 0;
    await expect(
      fetchWithRetry("https://example.test/feed", {
        retries: 1,
        baseDelayMs: 1,
        fetchImpl: () => {
          calls++;
          return Promise.reject(new Error("network down"));
        },
      }),
    ).rejects.toThrow("network down");
    expect(calls).toBe(2);
  });

  it("does not retry a non-5xx, non-429 error response", async () => {
    let calls = 0;
    const result = await fetchWithRetry("https://example.test/feed", {
      retries: 2,
      baseDelayMs: 1,
      fetchImpl: () => {
        calls++;
        return Promise.resolve(response(404));
      },
    });
    expect(result.status).toBe(404);
    expect(calls).toBe(1);
  });
});
