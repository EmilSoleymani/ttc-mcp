import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../server.js";

export interface CallToolOutcome {
  isError: boolean;
  structuredContent: unknown;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildServer();
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
  });
}

/** Reads an MCP resource over a real in-memory client/server pair. */
export async function readResource(
  uri: string,
): Promise<{ uri: string; mimeType?: string; text: string }[]> {
  return withClient(async (client) => {
    const result = await client.readResource({ uri });
    return result.contents as {
      uri: string;
      mimeType?: string;
      text: string;
    }[];
  });
}
