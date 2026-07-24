#!/usr/bin/env node
// Run by the weekly smoke workflow (.github/workflows/smoke.yml): one
// schema-validated call per upstream domain. Exits non-zero if any check
// fails, so the workflow step fails and files an issue.
import { runSmokeChecks } from "../gtfs/smoke-checks.js";

const results = await runSmokeChecks();

let allOk = true;
for (const result of results) {
  const status = result.ok ? "OK" : "FAILED";
  console.error(
    `[${status}] ${result.name} (${result.domain}): ${result.detail}`,
  );
  if (!result.ok) allOk = false;
}

if (!allOk) {
  console.error("One or more smoke checks failed.");
  process.exit(1);
}
console.error("All smoke checks passed.");
