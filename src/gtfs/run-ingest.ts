import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { parse } from "csv-parse";
import unzipper from "unzipper";

import {
  type CsvRow,
  DEFAULT_SCHEDULES_URL,
  loadTable,
  TABLE_SPECS,
} from "./ingest.js";
import { applySchema } from "./schema.js";

export interface IngestOptions {
  /** Feed URL to download (default DEFAULT_SCHEDULES_URL). Ignored if zipPath is set. */
  schedulesUrl?: string;
  /** Local zip path to ingest instead of downloading (offline). */
  zipPath?: string;
  /** libSQL connection: `file:...` (local/Docker) or `libsql://...turso.io` (Turso). */
  dbUrl: string;
  authToken?: string;
}

export interface IngestResult {
  counts: Record<string, number>;
}

async function downloadToTemp(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GTFS feed download failed: HTTP ${String(res.status)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const path = join(tmpdir(), `ttc-gtfs-${String(Date.now())}.zip`);
  await writeFile(path, buffer);
  return path;
}

function parsedRecords(
  entryStream: NodeJS.ReadableStream,
): AsyncIterable<CsvRow> {
  // csv-parse's Parser is an AsyncIterable of header-keyed objects; the return
  // annotation narrows its element type. bom:true strips a UTF-8 BOM on the
  // first header.
  return entryStream.pipe(
    parse({ columns: true, skip_empty_lines: true, bom: true }),
  );
}

/**
 * Full-rebuild ingest: fetch Dataset A (or use a local zip), stream each GTFS
 * file into the optimized libSQL schema (stop_times is streamed, never
 * buffered), return per-table row counts. IO orchestration — verified by the
 * real ingest run and the smoke workflow, not the unit gate.
 */
export async function runIngest(options: IngestOptions): Promise<IngestResult> {
  const zipPath =
    options.zipPath ??
    (await downloadToTemp(options.schedulesUrl ?? DEFAULT_SCHEDULES_URL));

  const client = createClient(
    options.authToken !== undefined
      ? { url: options.dbUrl, authToken: options.authToken }
      : { url: options.dbUrl },
  );

  try {
    await applySchema(client);
    const directory = await unzipper.Open.file(zipPath);
    const counts: Record<string, number> = {};
    for (const spec of TABLE_SPECS) {
      const entry = directory.files.find((f) => f.path === spec.file);
      if (!entry) {
        throw new Error(`GTFS feed is missing ${spec.file}`);
      }
      counts[spec.table] = await loadTable(
        client,
        spec,
        parsedRecords(entry.stream()),
      );
    }
    return { counts };
  } finally {
    client.close();
  }
}
