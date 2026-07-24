import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createQueryClient, resolveIngestTargets } from "./db-client.js";

const ENV_KEYS = [
  "LIBSQL_URL",
  "LIBSQL_AUTH_TOKEN",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
] as const;

let saved: Record<string, string | undefined>;
let workDir: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  workDir = await mkdtemp(join(tmpdir(), "ttc-mcp-db-client-"));
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(workDir, { recursive: true, force: true });
});

describe("createQueryClient", () => {
  it("honors LIBSQL_URL when set", () => {
    process.env["LIBSQL_URL"] = ":memory:";
    const client = createQueryClient();
    expect(client.closed).toBe(false);
    client.close();
  });

  it("creates a missing parent directory for a local file: URL", () => {
    const dbPath = join(workDir, "nested", "ttc.db");
    process.env["LIBSQL_URL"] = `file:${dbPath}`;
    expect(existsSync(join(workDir, "nested"))).toBe(false);

    const client = createQueryClient();
    expect(existsSync(join(workDir, "nested"))).toBe(true);
    client.close();
  });
});

describe("resolveIngestTargets", () => {
  it("returns only the local target when Turso env vars are absent", () => {
    process.env["LIBSQL_URL"] = ":memory:";
    const targets = resolveIngestTargets();
    expect(targets).toHaveLength(1);
    for (const t of targets) t.close();
  });

  it("adds the Turso target when both TURSO_* vars are present", () => {
    process.env["LIBSQL_URL"] = ":memory:";
    process.env["TURSO_DATABASE_URL"] = ":memory:";
    process.env["TURSO_AUTH_TOKEN"] = "test-token";
    const targets = resolveIngestTargets();
    expect(targets).toHaveLength(2);
    for (const t of targets) t.close();
  });

  it("stays local-only if only one of the two Turso vars is set", () => {
    process.env["LIBSQL_URL"] = ":memory:";
    process.env["TURSO_DATABASE_URL"] = ":memory:";
    const targets = resolveIngestTargets();
    expect(targets).toHaveLength(1);
    for (const t of targets) t.close();
  });
});
