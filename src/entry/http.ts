#!/usr/bin/env node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { resolveRtClient } from "../gtfs-rt/rt-client.js";
import { resolveQueryClient } from "../gtfs/db-client.js";
import { buildServer } from "../server.js";

const port = Number(process.env.PORT ?? 3000);
// One shared read client + RT client for the process — @libsql/client
// connections are safe for concurrent use, and the RT client owns its own
// coalescing cache, so neither is re-resolved per request.
const db = resolveQueryClient();
const rt = resolveRtClient();

function methodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, { "content-type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
  );
}

// Pure liveness: no upstream call (stack-baseline: inherits go-planner's
// docker-deployment spec §2).
function health(res: ServerResponse): void {
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ status: "ok" }));
}

// One MCP server + transport per request, stateless mode
// (sessionIdGenerator omitted) — the same pattern the SDK's stateless example
// and Vercel's mcp-handler use, so every entry surface shares buildServer().
async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === "GET" || req.method === "DELETE") {
    methodNotAllowed(res);
    return;
  }

  const mcpServer = buildServer({ db, rt });
  const transport = new StreamableHTTPServerTransport({});
  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
  });
  await mcpServer.connect(transport as Transport);
  await transport.handleRequest(req, res);
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    health(res);
    return;
  }

  if (url.pathname === "/mcp") {
    handleMcp(req, res).catch((error: unknown) => {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    });
    return;
  }

  res.writeHead(404).end();
});

httpServer.listen(port, () => {
  console.error(`ttc-mcp listening on port ${String(port)}`);
});
