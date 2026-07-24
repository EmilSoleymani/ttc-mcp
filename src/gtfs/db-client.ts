import { type Client, createClient } from "@libsql/client";

/**
 * Resolves the read-side libSQL client from env: `LIBSQL_URL` (a `file:...`
 * path for Docker/dev or a `libsql://...turso.io` Turso URL) + optional
 * `LIBSQL_AUTH_TOKEN`, defaulting to the local dev/Docker ingest target. Same
 * one-`@libsql/client`-codepath contract the ingest side uses
 * (docs/spec/gtfs-ingestion.md §6).
 */
export function resolveQueryClient(): Client {
  const url = process.env.LIBSQL_URL ?? "file:./data/ttc.db";
  const authToken = process.env.LIBSQL_AUTH_TOKEN;
  return createClient(authToken !== undefined ? { url, authToken } : { url });
}
