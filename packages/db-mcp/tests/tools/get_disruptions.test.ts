import { describe, expect, it, vi } from "vitest";
import { makeGetDisruptionsTool } from "../../src/tools/get_disruptions.js";

describe("get_disruptions tool", () => {
  it("passes evaNumber filter through to the router", async () => {
    const router = {
      getDisruptions: vi.fn().mockResolvedValue({
        data: [
          { id: "1", headline: "Stellwerksstörung Köln", description: "...", severity: "high", affectedSegments: [] },
        ],
        source: "marudor",
        degraded: false,
      }),
    } as any;
    const tool = makeGetDisruptionsTool(router);
    const res = await tool.handler({ evaNumber: "8000207" });
    expect(router.getDisruptions).toHaveBeenCalledWith({ evaNumber: "8000207" });
    expect(res.data[0].severity).toBe("high");
  });

  it("works without evaNumber", async () => {
    const router = {
      getDisruptions: vi.fn().mockResolvedValue({ data: [], source: "marudor", degraded: false }),
    } as any;
    const tool = makeGetDisruptionsTool(router);
    const res = await tool.handler({});
    expect(router.getDisruptions).toHaveBeenCalledWith({ evaNumber: undefined });
    expect(res.data).toEqual([]);
  });
});
