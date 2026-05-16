import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// We expose two helpers in addition to the MCP `Server` so tests can drive
// the server without spinning up a stdio transport. The MCP server itself
// gets wired in src/index.ts.

export interface ServerHandle {
  server: Server;
  listTools: () => Promise<{ tools: Tool[] }>;
  callTool: (name: string, args: unknown) => Promise<CallToolResult>;
}

const PING_TOOL: Tool = {
  name: "ping",
  description: "Health check. Returns 'pong'.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export function createServer(): ServerHandle {
  const server = new Server(
    { name: "db-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const tools: Tool[] = [PING_TOOL];

  const listTools = async () => ({ tools });

  const callTool = async (name: string, _args: unknown): Promise<CallToolResult> => {
    if (name === "ping") {
      return { content: [{ type: "text", text: "pong" }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  };

  server.setRequestHandler(ListToolsRequestSchema, listTools);
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(req.params.name, req.params.arguments),
  );

  return { server, listTools, callTool };
}
