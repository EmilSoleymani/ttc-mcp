#!/usr/bin/env -S npx tsx
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveIngestTargets } from "../src/gtfs/db-client.js";
import { downloadToFile, resolveScheduleFeed } from "../src/gtfs/download.js";
import { ingestScheduleZip } from "../src/gtfs/ingest.js";

/**
 * CLI entry point driving the GTFS ingest: resolve Dataset A's current
 * download URL, stream it to a temp file, load the optimized schema into
 * every configured libSQL target (local file + Turso, when Turso's env vars
 * are set), and print a row-count summary. Same script drives both the CI
 * refresh workflow and a Docker image build (docs/spec/gtfs-ingestion.md §4).
 */
async function main(): Promise<void> {
  const { url, lastModified } = await resolveScheduleFeed();
  console.log(`Resolved schedules feed: ${url}`);
  if (lastModified) console.log(`  last_modified: ${lastModified}`);

  const workDir = await mkdtemp(join(tmpdir(), "ttc-mcp-ingest-"));
  const zipPath = join(workDir, "opendata_ttc_schedules.zip");
  try {
    console.log(`Downloading to ${zipPath}...`);
    await downloadToFile(url, zipPath);

    const targets = resolveIngestTargets();
    console.log(`Ingesting into ${targets.length} target(s)...`);
    const summary = await ingestScheduleZip(zipPath, targets);
    for (const target of targets) target.close();

    console.log("Ingest complete:");
    console.log(`  stops:          ${summary.stops}`);
    console.log(`  routes:         ${summary.routes}`);
    console.log(`  trips:          ${summary.trips}`);
    console.log(`  calendar:       ${summary.calendar}`);
    console.log(`  calendar_dates: ${summary.calendarDates}`);
    console.log(`  stop_times:     ${summary.stopTimes}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
