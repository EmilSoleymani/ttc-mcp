import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { downloadToFile, resolveScheduleFeed } from "./download.js";

// msw at the HTTP seam (stack-baseline: inherits go-planner's
// test-architecture spec verbatim) — mocks the CKAN API + zip download
// without reaching the real (egress-restricted) TTC host.
const CKAN_BASE_URL = "http://ckan.test";
// TextEncoder (not Buffer.from) so `.buffer` is sized to exactly this
// content — Buffer.from's small-allocation pool would otherwise hand back
// Node's shared 8 KiB pool ArrayBuffer instead of a tightly-sized one.
const ZIP_BYTES = new TextEncoder().encode(
  "PK\x03\x04fake-zip-bytes-for-download-test",
);

const server = setupServer(
  http.get(`${CKAN_BASE_URL}/api/3/action/package_show`, ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get("id") !== "ttc-routes-and-schedules") {
      return HttpResponse.json({ error: "unknown package" }, { status: 404 });
    }
    return HttpResponse.json({
      result: {
        resources: [
          {
            url: `${CKAN_BASE_URL}/download/opendata_ttc_schedules.zip`,
            last_modified: "2026-07-13T21:28:32",
          },
        ],
      },
    });
  }),
  http.get(`${CKAN_BASE_URL}/download/opendata_ttc_schedules.zip`, () =>
    HttpResponse.arrayBuffer(ZIP_BYTES.buffer, {
      headers: { "Content-Type": "application/zip" },
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ENV_KEYS = ["CKAN_BASE_URL", "GTFS_SCHEDULES_URL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env["CKAN_BASE_URL"] = CKAN_BASE_URL;
  delete process.env["GTFS_SCHEDULES_URL"];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("resolveScheduleFeed", () => {
  it("resolves the download URL + last_modified via CKAN package_show", async () => {
    const feed = await resolveScheduleFeed();
    expect(feed.url).toBe(
      `${CKAN_BASE_URL}/download/opendata_ttc_schedules.zip`,
    );
    expect(feed.lastModified).toBe("2026-07-13T21:28:32");
  });

  it("bypasses CKAN entirely when GTFS_SCHEDULES_URL is set", async () => {
    process.env["GTFS_SCHEDULES_URL"] = "https://example.test/override.zip";
    const feed = await resolveScheduleFeed();
    expect(feed.url).toBe("https://example.test/override.zip");
    expect(feed.lastModified).toBeUndefined();
  });

  it("throws when CKAN returns a non-OK response", async () => {
    server.use(
      http.get(`${CKAN_BASE_URL}/api/3/action/package_show`, () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    await expect(resolveScheduleFeed()).rejects.toThrow(/500/);
  });
});

describe("downloadToFile", () => {
  it("streams the response body to disk byte-for-byte", async () => {
    const destPath = join(tmpdir(), `ttc-mcp-download-test-${Date.now()}.zip`);
    try {
      await downloadToFile(
        `${CKAN_BASE_URL}/download/opendata_ttc_schedules.zip`,
        destPath,
      );
      const written = await readFile(destPath);
      expect(written.equals(ZIP_BYTES)).toBe(true);
    } finally {
      await rm(destPath, { force: true });
    }
  });

  it("creates missing parent directories", async () => {
    const destPath = join(
      tmpdir(),
      `ttc-mcp-download-test-nested-${Date.now()}`,
      "schedules.zip",
    );
    try {
      await downloadToFile(
        `${CKAN_BASE_URL}/download/opendata_ttc_schedules.zip`,
        destPath,
      );
      const written = await readFile(destPath);
      expect(written.length).toBe(ZIP_BYTES.length);
    } finally {
      await rm(join(destPath, ".."), { recursive: true, force: true });
    }
  });
});
