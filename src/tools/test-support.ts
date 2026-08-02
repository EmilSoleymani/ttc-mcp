import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { RtClient } from "../gtfs-rt/rt-client.js";
import { applySchema } from "../gtfs/schema.js";
import { buildServer, type ServerDeps } from "../server.js";

export interface CallToolOutcome {
  isError: boolean;
  structuredContent: unknown;
}

/** An empty (schema-only) in-memory db — enough for tools/resources that
 * don't exercise GTFS data (get_fare, ttc://fares) — plus an RT client with
 * caching disabled and no real fetch, for tools that don't exercise
 * live data either. */
async function defaultDeps(): Promise<ServerDeps> {
  const db = createClient({ url: ":memory:" });
  await applySchema(db);
  const rt = new RtClient({
    cacheEnabled: false,
    fetchImpl: () =>
      Promise.reject(
        new Error("Unexpected GTFS-RT fetch in a default test deps."),
      ),
  });
  return { db, rt };
}

async function withClient<T>(
  fn: (client: Client) => Promise<T>,
  deps?: ServerDeps,
): Promise<T> {
  const server = buildServer(deps ?? (await defaultDeps()));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** Shared MCP round-trip harness for tool tests. */
export async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  deps?: ServerDeps,
): Promise<CallToolOutcome> {
  return withClient(async (client) => {
    // Populates the SDK's per-tool output-schema validator cache (cached from
    // listTools(), not callTool()) so tests exercise the same
    // structuredContent/outputSchema validation a real client hits.
    await client.listTools();
    const result = await client.callTool({ name: toolName, arguments: args });
    return {
      isError: result.isError === true,
      structuredContent: result.structuredContent,
    };
  }, deps);
}

/** Reads an MCP resource over a real in-memory client/server pair. */
export async function readResource(
  uri: string,
  deps?: ServerDeps,
): Promise<{ uri: string; mimeType?: string; text: string }[]> {
  return withClient(async (client) => {
    const result = await client.readResource({ uri });
    return result.contents as {
      uri: string;
      mimeType?: string;
      text: string;
    }[];
  }, deps);
}
