#!/usr/bin/env node
// Run by the GTFS-refresh workflow (.github/workflows/gtfs-refresh.yml):
// polls CKAN for both ingested datasets and reports whether either changed
// since the last-committed state, via `$GITHUB_OUTPUT` when running in
// Actions (plain stderr otherwise, for local/manual runs).
import { appendFile, readFile } from "node:fs/promises";

import { checkFreshness, type FreshnessState } from "../gtfs/freshness.js";

const statePath =
  process.env.GTFS_FRESHNESS_STATE_PATH ?? ".github/gtfs-refresh-state.json";

async function readState(): Promise<FreshnessState | undefined> {
  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as FreshnessState;
  } catch {
    return undefined;
  }
}

const previous = await readState();
const { changed, current } = await checkFreshness(previous);

console.error(
  changed
    ? "GTFS data changed since the last refresh — rebuild + push needed."
    : "GTFS data unchanged since the last refresh — nothing to do.",
);
console.error(JSON.stringify(current, null, 2));

const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  await appendFile(
    githubOutput,
    `changed=${String(changed)}\nstate=${JSON.stringify(current)}\n`,
  );
}
