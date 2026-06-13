import { describe, expect, it, vi } from "vitest";
import { makeResolveStationTool } from "../../src/tools/resolve_station.js";

describe("resolve_station tool", () => {
  it("calls router.searchStations and wraps result", async () => {
    const router = {
      searchStations: vi.fn().mockResolvedValue({
        data: [{ name: "Köln Hbf", evaNumber: "8000207" }],
        source: "marudor",
        degraded: false,
      }),
    } as any;
    const tool = makeResolveStationTool(router);
    const result = await tool.handler({ query: "Koeln" });
    expect(router.searchStations).toHaveBeenCalledWith("Koeln");
    expect(result.source).toBe("marudor");
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("rejects invalid input via zod", () => {
    const tool = makeResolveStationTool({} as any);
    expect(() => tool.schema.parse({})).toThrow();
  });
});
