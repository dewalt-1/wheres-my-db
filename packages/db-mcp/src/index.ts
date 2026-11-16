#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { runCommand } from "./setup-db-api.js";

// stdio transport: JSON-RPC messages are framed on stdin/stdout.
// Claude (the MCP client) spawns this process and speaks JSON-RPC over the pipe.
// stderr is free for our own logs — Claude won't interpret it.

async function main() {
  // Terminal commands for the optional DB API key; otherwise start the server.
  const command = process.argv[2];
  if (command) {
    const code = await runCommand(command);
    if (code !== undefined) process.exit(code);
    console.error(`Unknown command: ${command}. Commands: setup-db-api, db-api-status, remove-db-api`);
    process.exit(2);
  }

  const { server } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("db-mcp listening on stdio");
}

main().catch((err) => {
  console.error("db-mcp fatal:", err);
  process.exit(1);
});
