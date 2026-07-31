import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Client, createClient } from "@libsql/client";
import { parse } from "csv-parse";
import unzipper from "unzipper";

import {
  type CsvRow,
  DEFAULT_MERGED_URL,
  DEFAULT_SCHEDULES_URL,
  enrichStationsFromDatasetB,
  loadTable,
  MERGED_TABLE_SPECS,
  TABLE_SPECS,
} from "./ingest.js";
import { applySchema } from "./schema.js";
import {
  buildPathwayTransfers,
  buildStationTransfers,
  buildStreetTransfers,
  insertTransfers,
  mergeTransfers,
  type PathwayIdentity,
  type StopIdentity,
} from "./transfers.js";

export interface IngestOptions {
  /** Feed URL to download (default DEFAULT_SCHEDULES_URL). Ignored if zipPath is set. */
  schedulesUrl?: string;
  /** Local zip path to ingest instead of downloading (offline). */
  zipPath?: string;
  /** Dataset B feed URL, for pathways/levels only (default DEFAULT_MERGED_URL). Ignored if mergedZipPath is set. */
  mergedUrl?: string;
  /** Local Dataset B zip path instead of downloading (offline). */
  mergedZipPath?: string;
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

async function loadZip(
  zipPath: string,
  specs: typeof TABLE_SPECS,
  client: Client,
  counts: Record<string, number>,
): Promise<void> {
  const directory = await unzipper.Open.file(zipPath);
  for (const spec of specs) {
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
}

async function fetchStopIdentities(client: Client): Promise<StopIdentity[]> {
  const result = await client.execute(
    "SELECT stop_id, parent_station, stop_lat, stop_lon, location_type FROM stops",
  );
  return result.rows.map((row) => ({
    stop_id: Number(row.stop_id),
    parent_station:
      row.parent_station === null ? null : Number(row.parent_station),
    stop_lat: row.stop_lat === null ? null : Number(row.stop_lat),
    stop_lon: row.stop_lon === null ? null : Number(row.stop_lon),
    location_type:
      row.location_type === null ? null : Number(row.location_type),
  }));
}

async function fetchPathwayIdentities(
  client: Client,
): Promise<PathwayIdentity[]> {
  const result = await client.execute(
    "SELECT from_stop_id, to_stop_id, is_bidirectional, traversal_time, length FROM pathways",
  );
  return result.rows.map((row) => ({
    from_stop_id: Number(row.from_stop_id),
    to_stop_id: Number(row.to_stop_id),
    is_bidirectional:
      row.is_bidirectional === null ? null : Number(row.is_bidirectional),
    traversal_time:
      row.traversal_time === null ? null : Number(row.traversal_time),
    length: row.length === null ? null : Number(row.length),
  }));
}

/**
 * Full-rebuild ingest: fetch Dataset A (schedule tables) and Dataset B
 * (pathways/levels only), stream each GTFS file into the optimized libSQL
 * schema (stop_times is streamed, never buffered), then synthesize the
 * transfers table (station/pathway/street) from the just-loaded stops +
 * pathways. Returns per-table row counts. IO orchestration — verified by the
 * real ingest run and the smoke workflow, not the unit gate.
 */
export async function runIngest(options: IngestOptions): Promise<IngestResult> {
  const zipPath =
    options.zipPath ??
    (await downloadToTemp(options.schedulesUrl ?? DEFAULT_SCHEDULES_URL));
  const mergedZipPath =
    options.mergedZipPath ??
    (await downloadToTemp(options.mergedUrl ?? DEFAULT_MERGED_URL));

  const client = createClient(
    options.authToken !== undefined
      ? { url: options.dbUrl, authToken: options.authToken }
      : { url: options.dbUrl },
  );

  try {
    await applySchema(client);
    const counts: Record<string, number> = {};
    await loadZip(zipPath, TABLE_SPECS, client, counts);
    await loadZip(mergedZipPath, MERGED_TABLE_SPECS, client, counts);

    // Overlay Dataset B's station hierarchy (location_type/parent_station)
    // onto the Dataset-A stops — Dataset A leaves those columns empty.
    const mergedDir = await unzipper.Open.file(mergedZipPath);
    const bStopsEntry = mergedDir.files.find((f) => f.path === "stops.txt");
    if (!bStopsEntry) {
      throw new Error("Dataset B feed is missing stops.txt");
    }
    const enriched = await enrichStationsFromDatasetB(
      client,
      parsedRecords(bStopsEntry.stream()),
    );
    counts.stops_enriched = enriched.platformsLinked;
    counts.stations_added = enriched.stationsInserted;

    const [stops, pathways] = await Promise.all([
      fetchStopIdentities(client),
      fetchPathwayIdentities(client),
    ]);
    const knownStopIds = new Set(stops.map((s) => s.stop_id));
    const transfers = mergeTransfers(
      buildStationTransfers(stops),
      buildPathwayTransfers(pathways, knownStopIds),
      buildStreetTransfers(stops),
    );
    counts.transfers = await insertTransfers(client, transfers);

    return { counts };
  } finally {
    client.close();
  }
}
