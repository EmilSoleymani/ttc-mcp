// The weekly smoke workflow's checks (docs/spec/stack-baseline.md "Caching &
// retry" / cicd-pipeline delta: "schema-validated smoke ... exercise: the
// static feed download, all three RT feeds"): one call per upstream domain,
// each validated against the shape the ingest/RT pipeline actually expects
// — not just an HTTP 200.
// gtfs-realtime-bindings is a CommonJS module whose named exports are
// assigned dynamically at runtime (not a static `module.exports = {...}`
// literal) — cjs-module-lexer can't detect `transit_realtime` as a named
// export, so a real Node ESM `import { transit_realtime } from
// "gtfs-realtime-bindings"` throws at runtime despite type-checking fine.
// Go through the default (guaranteed = the whole `module.exports`) instead.
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

import { CKAN_PACKAGE_SHOW_URL, SCHEDULES_DATASET } from "./freshness.js";

const { transit_realtime } = GtfsRealtimeBindings;

export const DEFAULT_SMOKE_RT_BASE_URL = "https://bustime.ttc.ca/gtfsrt";

export interface SmokeCheckResult {
  name: string;
  domain: string;
  ok: boolean;
  detail: string;
}

function ok(name: string, domain: string, detail: string): SmokeCheckResult {
  return { name, domain, ok: true, detail };
}

function failed(
  name: string,
  domain: string,
  detail: string,
): SmokeCheckResult {
  return { name, domain, ok: false, detail };
}

/** One call to the static-GTFS domain (CKAN): fetches the schedules
 * dataset's package_show and validates the tracked resource is present with
 * a download URL — the same shape the ingest pipeline (and the GTFS-refresh
 * freshness poll) depends on. */
export async function checkStaticFeedDomain(
  fetchImpl: typeof fetch = fetch,
): Promise<SmokeCheckResult> {
  const name = "static GTFS feed (CKAN package_show)";
  const domain = new URL(CKAN_PACKAGE_SHOW_URL).hostname;
  try {
    const response = await fetchImpl(
      `${CKAN_PACKAGE_SHOW_URL}?id=${SCHEDULES_DATASET.packageId}`,
    );
    if (!response.ok) {
      return failed(name, domain, `HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as {
      success?: boolean;
      result?: { resources?: { id: string; url?: string }[] };
    };
    if (body.success !== true) {
      return failed(name, domain, "CKAN reported success=false");
    }
    const resource = body.result?.resources?.find(
      (r) => r.id === SCHEDULES_DATASET.resourceId,
    );
    if (!resource?.url) {
      return failed(
        name,
        domain,
        `tracked resource ${SCHEDULES_DATASET.resourceId} missing or has no url`,
      );
    }
    return ok(name, domain, `resource url present (${resource.url})`);
  } catch (error) {
    return failed(name, domain, String(error));
  }
}

/** One call to the GTFS-Realtime domain (bustime.ttc.ca): fetches the
 * VehiclePositions feed and decodes it as a GTFS-RT v2.0 FeedMessage,
 * validating the header + entity list shape TripUpdates/VehiclePositions
 * decoding depends on (docs/spec/realtime-integration.md). */
export async function checkRealtimeFeedDomain(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = DEFAULT_SMOKE_RT_BASE_URL,
): Promise<SmokeCheckResult> {
  const name = "GTFS-Realtime feed (VehiclePositions)";
  const domain = new URL(baseUrl).hostname;
  try {
    const response = await fetchImpl(`${baseUrl}/vehicles`);
    if (!response.ok) {
      return failed(name, domain, `HTTP ${String(response.status)}`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    const feed = transit_realtime.FeedMessage.decode(buffer);
    if (feed.header.gtfsRealtimeVersion !== "2.0") {
      return failed(
        name,
        domain,
        `unexpected gtfs_realtime_version "${feed.header.gtfsRealtimeVersion}"`,
      );
    }
    if (!Array.isArray(feed.entity)) {
      return failed(name, domain, "decoded feed has no entity list");
    }
    return ok(
      name,
      domain,
      `decoded FeedMessage v${feed.header.gtfsRealtimeVersion}, ${String(feed.entity.length)} entities`,
    );
  } catch (error) {
    return failed(name, domain, String(error));
  }
}

/** Runs every upstream-domain smoke check, one call each. The GTFS-RT base URL
 * can be overridden via the SMOKE_RT_BASE_URL env var (the smoke workflow
 * exposes it as a workflow_dispatch input) — point it at an unreachable URL to
 * exercise the failure/issue-filing path without breaking the real check. */
export async function runSmokeChecks(
  fetchImpl: typeof fetch = fetch,
  rtBaseUrl: string = process.env.SMOKE_RT_BASE_URL ||
    DEFAULT_SMOKE_RT_BASE_URL,
): Promise<SmokeCheckResult[]> {
  return Promise.all([
    checkStaticFeedDomain(fetchImpl),
    checkRealtimeFeedDomain(fetchImpl, rtBaseUrl),
  ]);
}
