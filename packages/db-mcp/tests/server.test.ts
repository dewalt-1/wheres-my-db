import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";

function stubProviders() {
  const router = {
    searchStations: vi.fn().mockResolvedValue({
      data: [{ name: "Köln Hbf", evaNumber: "8000207" }],
      source: "marudor",
      degraded: false,
    }),
    getTrainStatus: vi.fn(),
    searchJourneys: vi.fn(),
    getDisruptions: vi.fn(),
  };
  return { router: router as any };
}

describe("createServer", () => {
  it("exposes the five tools", async () => {
    const { listTools } = createServer({ providers: stubProviders() });
    const result = await listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "find_train",
      "get_disruptions",
      "get_train_status",
      "plan_journey",
      "resolve_station",
    ]);
  });

  it("dispatches resolve_station through to the router", async () => {
    const stubs = stubProviders();
    const { callTool } = createServer({ providers: stubs });
    const result = await callTool("resolve_station", { query: "Koeln" });
    expect(stubs.router.searchStations).toHaveBeenCalledWith("Koeln");
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body._meta.source).toBe("marudor");
  });

  it("returns an isError result for unknown tool", async () => {
    const { callTool } = createServer({ providers: stubProviders() });
    const res = await callTool("nope", {});
    expect(res.isError).toBe(true);
  });

  it("returns an isError result for invalid args", async () => {
    const { callTool } = createServer({ providers: stubProviders() });
    const res = await callTool("resolve_station", { query: "" });
    expect(res.isError).toBe(true);
  });
});
