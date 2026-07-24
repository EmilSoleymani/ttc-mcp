#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveQueryClient } from "../gtfs/db-client.js";
import { buildServer } from "../server.js";

const server = buildServer({ db: resolveQueryClient() });
await server.connect(new StdioServerTransport());
