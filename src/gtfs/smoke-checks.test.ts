import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { describe, expect, it } from "vitest";

import { SCHEDULES_DATASET } from "./freshness.js";
import {
  checkRealtimeFeedDomain,
  checkStaticFeedDomain,
  runSmokeChecks,
} from "./smoke-checks.js";

const { transit_realtime } = GtfsRealtimeBindings;

function ckanOkResponse(): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: {
        resources: [
          {
            id: SCHEDULES_DATASET.resourceId,
            url: "https://example.test/opendata_ttc_schedules.zip",
          },
        ],
      },
    }),
    { status: 200 },
  );
}

function encodedFeed(): Uint8Array {
  const message = transit_realtime.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
      timestamp: 1_000,
    },
    entity: [
      {
        id: "1",
        vehicle: {
          vehicle: { id: "v1" },
          position: { latitude: 43.6, longitude: -79.4 },
        },
      },
    ],
  });
  return transit_realtime.FeedMessage.encode(message).finish();
}

describe("checkStaticFeedDomain", () => {
  it("passes when the tracked resource is present with a url", async () => {
    const result = await checkStaticFeedDomain(() =>
      Promise.resolve(ckanOkResponse()),
    );
    expect(result.ok).toBe(true);
    expect(result.domain).toBe("ckan0.cf.opendata.inter.prod-toronto.ca");
  });

  it("fails on a non-ok HTTP response", async () => {
    const result = await checkStaticFeedDomain(() =>
      Promise.resolve(new Response(null, { status: 503 })),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/503/);
  });

  it("fails when the tracked resource is missing", async () => {
    const result = await checkStaticFeedDomain(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: true, result: { resources: [] } }),
          {
            status: 200,
          },
        ),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/missing/);
  });
});

describe("checkRealtimeFeedDomain", () => {
  it("passes when the feed decodes as a v2.0 FeedMessage", async () => {
    const body = encodedFeed();
    const result = await checkRealtimeFeedDomain(() =>
      Promise.resolve(new Response(body, { status: 200 })),
    );
    expect(result.ok).toBe(true);
    expect(result.domain).toBe("bustime.ttc.ca");
    expect(result.detail).toMatch(/1 entities/);
  });

  it("fails on a non-ok HTTP response", async () => {
    const result = await checkRealtimeFeedDomain(() =>
      Promise.resolve(new Response(null, { status: 500 })),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/500/);
  });

  it("fails when the body doesn't decode as a FeedMessage", async () => {
    const result = await checkRealtimeFeedDomain(() =>
      Promise.resolve(
        new Response(new Uint8Array([0xff, 0xff, 0xff]), { status: 200 }),
      ),
    );
    expect(result.ok).toBe(false);
  });
});

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

describe("runSmokeChecks", () => {
  it("runs one check per upstream domain", async () => {
    const results = await runSmokeChecks((input) => {
      const url = urlOf(input);
      if (url.includes("ckan")) return Promise.resolve(ckanOkResponse());
      return Promise.resolve(new Response(encodedFeed(), { status: 200 }));
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    const domains = new Set(results.map((r) => r.domain));
    expect(domains.size).toBe(2);
  });
});
