import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const DEFAULT_CKAN_BASE_URL = "https://ckan0.cf.opendata.inter.prod-toronto.ca";

// Dataset A — "ttc-routes-and-schedules" (docs/spec/gtfs-ingestion.md §3,
// .wayfinder/research/001-ttc-feed-inventory.md Q1). Canonical, freshest
// schedules; the only dataset this ingest slice reads (pathways/levels from
// Dataset B are a separate slice, issue #5).
const SCHEDULES_PACKAGE_ID = "ttc-routes-and-schedules";

interface CkanPackageShowResponse {
  result: {
    resources: { url: string; last_modified?: string }[];
  };
}

export interface ResolvedFeed {
  url: string;
  lastModified: string | undefined;
}

/**
 * Resolves the current download URL (+ last_modified, for change-detection
 * by the refresh workflow) for Dataset A via CKAN `package_show`. Honors
 * `GTFS_SCHEDULES_URL` as a direct override, bypassing the CKAN call
 * entirely (docs/spec/gtfs-ingestion.md §6 config surface).
 */
export async function resolveScheduleFeed(): Promise<ResolvedFeed> {
  const override = process.env["GTFS_SCHEDULES_URL"];
  if (override) {
    return { url: override, lastModified: undefined };
  }

  const ckanBaseUrl = process.env["CKAN_BASE_URL"] ?? DEFAULT_CKAN_BASE_URL;
  const endpoint = `${ckanBaseUrl}/api/3/action/package_show?id=${SCHEDULES_PACKAGE_ID}`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(
      `CKAN package_show failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as CkanPackageShowResponse;
  const resource = body.result.resources[0];
  if (!resource) {
    throw new Error("CKAN package_show returned no resources");
  }
  return { url: resource.url, lastModified: resource.last_modified };
}

/**
 * Downloads a URL straight to disk via a piped stream — the zip is ~35 MB
 * and must never be buffered whole in memory (same streaming discipline as
 * the CSV entries inside it).
 */
export async function downloadToFile(
  url: string,
  destPath: string,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${url}`);
  }
  await mkdir(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
}
