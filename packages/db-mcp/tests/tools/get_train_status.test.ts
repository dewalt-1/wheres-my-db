import { describe, expect, it, vi } from "vitest";
import { makeGetTrainStatusTool } from "../../src/tools/get_train_status.js";

describe("get_train_status tool", () => {
  it("returns full TrainStatus with stopovers and connections", async () => {
    const fakeStatus = {
      identifier: {
        journeyId: "ICE 597",
        name: "ICE 597",
        origin: "Hamburg-Altona",
        destination: "München Hbf",
        date: "2026-05-15",
      },
      stopovers: [
        {
          stationName: "Hannover Hbf",
          evaNumber: "8000152",
          arrivalDelayMinutes: 12,
          outgoingConnections: [],
          messages: [],
          cancelled: false,
        },
      ],
      messages: [],
      cancelled: false,
    };
    const router = {
      getTrainStatus: vi.fn().mockResolvedValue({ data: fakeStatus, source: "marudor", degraded: false }),
    } as any;
    const tool = makeGetTrainStatusTool(router);
    const result = await tool.handler({ name: "ICE 597" });
    expect(router.getTrainStatus).toHaveBeenCalledWith("ICE 597", undefined);
    expect(result.data.stopovers[0].stationName).toBe("Hannover Hbf");
    expect(result.data.stopovers[0].arrivalDelayMinutes).toBe(12);
  });

  it("passes date through to router", async () => {
    const router = {
      getTrainStatus: vi.fn().mockResolvedValue({ data: { identifier: {}, stopovers: [], messages: [], cancelled: false }, source: "marudor", degraded: false }),
    } as any;
    const tool = makeGetTrainStatusTool(router);
    await tool.handler({ name: "ICE 597", date: "2026-05-20" });
    expect(router.getTrainStatus).toHaveBeenCalledWith("ICE 597", "2026-05-20");
  });
});
