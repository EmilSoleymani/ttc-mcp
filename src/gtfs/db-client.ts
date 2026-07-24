import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";

const DEFAULT_LOCAL_URL = "file:./data/ttc.db";

/**
 * `@libsql/client` does not create missing parent directories for a `file:`
 * URL (it fails with a raw connection error instead), so a fresh checkout
 * without a `data/` directory would fail to boot. Only touches `file:` URLs;
 * `:memory:` and remote `libsql:`/`https:` URLs are untouched.
 */
function ensureLocalFileDir(url: string): void {
  if (!url.startsWith("file:")) return;
  const path = url.slice("file:".length);
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * The query-layer client: one `@libsql/client` codepath serves both hosting
 * targets (docs/spec/gtfs-ingestion.md §1) — Vercel points `LIBSQL_URL` at a
 * remote `libsql://…turso.io` database, Docker/dev points it at a local
 * `file:` path. Defaults to a local dev file so the server boots with zero
 * config before the first ingest.
 */
export function createQueryClient(): Client {
  const url = process.env["LIBSQL_URL"] ?? DEFAULT_LOCAL_URL;
  ensureLocalFileDir(url);
  const authToken = process.env["LIBSQL_AUTH_TOKEN"];
  return authToken ? createClient({ url, authToken }) : createClient({ url });
}

/**
 * The ingest job's write targets: always the local libSQL file (dev/Docker
 * bake), plus the remote Turso database when its CI secrets are present
 * (docs/spec/gtfs-ingestion.md §6). Same schema, same statements, both
 * targets — that's what "syncing to Turso" means here.
 */
export function resolveIngestTargets(): Client[] {
  const localUrl = process.env["LIBSQL_URL"] ?? DEFAULT_LOCAL_URL;
  ensureLocalFileDir(localUrl);
  const targets = [createClient({ url: localUrl })];

  const tursoUrl = process.env["TURSO_DATABASE_URL"];
  const tursoAuthToken = process.env["TURSO_AUTH_TOKEN"];
  if (tursoUrl && tursoAuthToken) {
    targets.push(createClient({ url: tursoUrl, authToken: tursoAuthToken }));
  }

  return targets;
}
