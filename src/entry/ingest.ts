#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_MERGED_URL, DEFAULT_SCHEDULES_URL } from "../gtfs/ingest.js";
import { runIngest } from "../gtfs/run-ingest.js";

const schedulesUrl = process.env.GTFS_SCHEDULES_URL ?? DEFAULT_SCHEDULES_URL;
const mergedUrl = process.env.GTFS_MERGED_URL ?? DEFAULT_MERGED_URL;
const dbUrl = process.env.LIBSQL_URL ?? "file:./data/ttc.db";
const authToken = process.env.LIBSQL_AUTH_TOKEN;

// Local file target (dev/Docker): make sure the directory exists.
if (dbUrl.startsWith("file:")) {
  const path = dbUrl.slice("file:".length);
  await mkdir(dirname(path) || ".", { recursive: true });
}

const started = Date.now();
const result = await runIngest(
  authToken !== undefined
    ? { schedulesUrl, mergedUrl, dbUrl, authToken }
    : { schedulesUrl, mergedUrl, dbUrl },
);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.error(`Ingest complete in ${seconds}s → ${dbUrl}`);
for (const [table, count] of Object.entries(result.counts)) {
  console.error(`  ${table}: ${String(count)}`);
}
