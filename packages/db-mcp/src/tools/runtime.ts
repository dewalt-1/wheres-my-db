import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ZodSchema } from "zod";
import type { SourcedResponse } from "../types.js";

export interface ToolDef<TInput> {
  spec: Tool;
  schema: ZodSchema<TInput>;
  handler: (input: TInput) => Promise<SourcedResponse<unknown>>;
}

// Turns a SourcedResponse into the MCP CallToolResult shape, embedding the
// data source as _meta so the skill can say where an answer came from.
export function asResult(res: SourcedResponse<unknown>): CallToolResult {
  const meta: { source: string; mapUrl?: string } = { source: res.source };
  if (res.mapUrl) meta.mapUrl = res.mapUrl;
  const body = { data: res.data, _meta: meta };
  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify(body, null, 2) },
  ];
  // A second block keeps the diagram's real line breaks, ready to paste.
  if (res.diagram) {
    const link = res.mapUrl ? `\n\nLive map: ${res.mapUrl}` : "";
    content.push({ type: "text", text: `${res.diagram}${link}` });
  }
  return { content };
}

export function asError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
