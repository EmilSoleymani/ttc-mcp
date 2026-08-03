import { describe, expect, it } from "vitest";

import {
  checkFreshness,
  fetchResourceStamp,
  MERGED_DATASET,
  SCHEDULES_DATASET,
  type FreshnessState,
} from "./freshness.js";

function ckanResponse(
  packageId: string,
  resources: {
    id: string;
    last_modified?: string;
    metadata_modified?: string;
  }[],
): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: { id: packageId, resources },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function fetchStub(byPackageId: Record<string, Response>): typeof fetch {
  return (input) => {
    const url = urlOf(input);
    for (const [packageId, response] of Object.entries(byPackageId)) {
      if (url.includes(packageId)) return Promise.resolve(response.clone());
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

describe("fetchResourceStamp", () => {
  it("returns the tracked resource's last_modified", async () => {
    const fetchImpl = fetchStub({
      [SCHEDULES_DATASET.packageId]: ckanResponse(SCHEDULES_DATASET.packageId, [
        {
          id: SCHEDULES_DATASET.resourceId,
          last_modified: "2026-07-20T00:00:00",
        },
        { id: "some-other-resource", last_modified: "2020-01-01T00:00:00" },
      ]),
    });
    const stamp = await fetchResourceStamp(SCHEDULES_DATASET, fetchImpl);
    expect(stamp).toBe("2026-07-20T00:00:00");
  });

  it("falls back to metadata_modified when last_modified is absent", async () => {
    const fetchImpl = fetchStub({
      [SCHEDULES_DATASET.packageId]: ckanResponse(SCHEDULES_DATASET.packageId, [
        {
          id: SCHEDULES_DATASET.resourceId,
          metadata_modified: "2026-07-01T00:00:00",
        },
      ]),
    });
    const stamp = await fetchResourceStamp(SCHEDULES_DATASET, fetchImpl);
    expect(stamp).toBe("2026-07-01T00:00:00");
  });

  it("throws when the tracked resource is missing from the package", async () => {
    const fetchImpl = fetchStub({
      [SCHEDULES_DATASET.packageId]: ckanResponse(SCHEDULES_DATASET.packageId, [
        { id: "unrelated-resource", last_modified: "2026-07-20T00:00:00" },
      ]),
    });
    await expect(
      fetchResourceStamp(SCHEDULES_DATASET, fetchImpl),
    ).rejects.toThrow(/has no resource/);
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 500 }));
    await expect(
      fetchResourceStamp(SCHEDULES_DATASET, fetchImpl),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws when CKAN reports success=false", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false }), { status: 200 }),
      );
    await expect(
      fetchResourceStamp(SCHEDULES_DATASET, fetchImpl),
    ).rejects.toThrow(/success=false/);
  });
});

describe("checkFreshness", () => {
  function fetchBoth(schedules: string, merged: string): typeof fetch {
    return fetchStub({
      [SCHEDULES_DATASET.packageId]: ckanResponse(SCHEDULES_DATASET.packageId, [
        { id: SCHEDULES_DATASET.resourceId, last_modified: schedules },
      ]),
      [MERGED_DATASET.packageId]: ckanResponse(MERGED_DATASET.packageId, [
        { id: MERGED_DATASET.resourceId, last_modified: merged },
      ]),
    });
  }

  it("reports changed when there is no previous state (first run)", async () => {
    const result = await checkFreshness(undefined, fetchBoth("a", "b"));
    expect(result.changed).toBe(true);
    expect(result.current).toEqual({ schedules: "a", merged: "b" });
  });

  it("reports unchanged when both stamps match the previous state", async () => {
    const previous: FreshnessState = { schedules: "a", merged: "b" };
    const result = await checkFreshness(previous, fetchBoth("a", "b"));
    expect(result.changed).toBe(false);
  });

  it("reports changed when only one stamp differs", async () => {
    const previous: FreshnessState = { schedules: "a", merged: "b" };
    const result = await checkFreshness(previous, fetchBoth("a", "b2"));
    expect(result.changed).toBe(true);
  });
});
