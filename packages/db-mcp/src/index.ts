#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdio transport: JSON-RPC messages are framed on stdin/stdout.
// Claude (the MCP client) spawns this process and speaks JSON-RPC over the pipe.
// stderr is free for our own logs — Claude won't interpret it.

async function main() {
  const { server } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("db-mcp listening on stdio");
}

main().catch((err) => {
  console.error("db-mcp fatal:", err);
  process.exit(1);
});
