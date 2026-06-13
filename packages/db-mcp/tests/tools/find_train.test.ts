import { describe, expect, it, vi } from "vitest";
import { makeFindTrainTool } from "../../src/tools/find_train.js";

describe("find_train tool", () => {
  it("returns a TrainIdentifier built from train status", async () => {
    const router = {
      getTrainStatus: vi.fn().mockResolvedValue({
        data: {
          identifier: {
            journeyId: "1|abc",
            name: "ICE 597",
            origin: "Hamburg-Altona",
            destination: "München Hbf",
            date: "2026-05-15",
          },
          stopovers: [],
          messages: [],
          cancelled: false,
        },
        source: "marudor",
        degraded: false,
      }),
    } as any;
    const tool = makeFindTrainTool(router);
    const result = await tool.handler({ name: "ICE 597" });
    expect(result.data.name).toBe("ICE 597");
    expect(result.data.journeyId).toBe("1|abc");
    expect(router.getTrainStatus).toHaveBeenCalledWith("ICE 597", undefined);
  });
});
