import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

describe("createServer", () => {
  it("exposes a ping tool", async () => {
    const { listTools } = createServer();
    const result = await listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("ping");
  });

  it("ping returns pong", async () => {
    const { callTool } = createServer();
    const result = await callTool("ping", {});
    expect(result.content[0]).toEqual({ type: "text", text: "pong" });
  });
});
