import { parse } from "csv-parse";
import * as unzipper from "unzipper";

/**
 * Streams CSV records out of one named entry of a (possibly large) zip file
 * without ever buffering the whole entry in memory: `unzipper` opens only
 * the entry's compressed byte range on demand, and `csv-parse` parses it
 * row-by-row as bytes arrive. `stop_times.txt` alone is ~4.2M rows / ~200 MB
 * uncompressed — this must stream (docs/spec/gtfs-ingestion.md).
 */
export async function* streamCsvEntries(
  zipPath: string,
  entryName: string,
): AsyncGenerator<Record<string, string>> {
  const directory = await unzipper.Open.file(zipPath);
  const file = directory.files.find(
    (f) => f.path === entryName && f.type === "File",
  );
  if (!file) {
    throw new Error(`Entry not found in zip: ${entryName}`);
  }

  const parser = file.stream().pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }),
  );

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    yield record;
  }
}

/** True if the zip contains an entry with this exact path. */
export async function zipHasEntry(
  zipPath: string,
  entryName: string,
): Promise<boolean> {
  const directory = await unzipper.Open.file(zipPath);
  return directory.files.some((f) => f.path === entryName && f.type === "File");
}
