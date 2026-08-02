#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveRtClient } from "../gtfs-rt/rt-client.js";
import { resolveQueryClient } from "../gtfs/db-client.js";
import { buildServer } from "../server.js";

const server = buildServer({ db: resolveQueryClient(), rt: resolveRtClient() });
await server.connect(new StdioServerTransport());
