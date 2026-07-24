// GTFS-refresh freshness polling (docs/spec/gtfs-ingestion.md "Refresh
// model"): weekly cron calls CKAN `package_show` for both ingested datasets
// and compares the tracked resource's freshness stamp against the
// last-ingested state, so the refresh workflow only rebuilds + pushes to
// Turso on an actual upstream change.

export interface DatasetRef {
  packageId: string;
  resourceId: string;
}

// The same CKAN package/resource ids DEFAULT_SCHEDULES_URL/
// DEFAULT_MERGED_URL download from (src/gtfs/ingest.ts) — a poll checks the
// freshness of the exact resources the ingest pipeline reads.
export const SCHEDULES_DATASET: DatasetRef = {
  packageId: "7795b45e-e65a-4465-81fc-c36b9dfff169",
  resourceId: "cfb6b2b8-6191-41e3-bda1-b175c51148cb",
};
export const MERGED_DATASET: DatasetRef = {
  packageId: "b811ead4-6eaf-4adb-8408-d389fb5a069c",
  resourceId: "c920e221-7a1c-488b-8c5b-6d8cd4e85eaf",
};

export const CKAN_PACKAGE_SHOW_URL =
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show";

interface CkanResource {
  id: string;
  last_modified?: string | null;
  metadata_modified?: string | null;
}
interface CkanPackageShowResponse {
  success?: boolean;
  result?: { resources?: CkanResource[] };
}

/** The freshness stamp CKAN reports for a dataset's tracked resource
 * (`last_modified`, falling back to `metadata_modified` — CKAN only sets
 * the former once a resource has been re-uploaded at least once). */
export async function fetchResourceStamp(
  dataset: DatasetRef,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `${CKAN_PACKAGE_SHOW_URL}?id=${dataset.packageId}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `CKAN package_show failed for package ${dataset.packageId}: HTTP ${String(response.status)}`,
    );
  }
  const body = (await response.json()) as CkanPackageShowResponse;
  if (body.success !== true) {
    throw new Error(
      `CKAN package_show returned success=false for package ${dataset.packageId}`,
    );
  }
  const resource = body.result?.resources?.find(
    (r) => r.id === dataset.resourceId,
  );
  if (!resource) {
    throw new Error(
      `CKAN package ${dataset.packageId} has no resource ${dataset.resourceId}`,
    );
  }
  const stamp = resource.last_modified ?? resource.metadata_modified;
  if (!stamp) {
    throw new Error(
      `CKAN resource ${dataset.resourceId} has neither last_modified nor metadata_modified`,
    );
  }
  return stamp;
}

export interface FreshnessState {
  schedules: string;
  merged: string;
}

export interface FreshnessCheck {
  changed: boolean;
  current: FreshnessState;
}

/** Compares the live CKAN stamps for both ingested datasets against the
 * last-ingested state. No previous state (first run, or the state file was
 * never committed) always counts as changed. */
export async function checkFreshness(
  previous: FreshnessState | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<FreshnessCheck> {
  const [schedules, merged] = await Promise.all([
    fetchResourceStamp(SCHEDULES_DATASET, fetchImpl),
    fetchResourceStamp(MERGED_DATASET, fetchImpl),
  ]);
  const current: FreshnessState = { schedules, merged };
  const changed =
    previous === undefined ||
    previous.schedules !== current.schedules ||
    previous.merged !== current.merged;
  return { changed, current };
}
