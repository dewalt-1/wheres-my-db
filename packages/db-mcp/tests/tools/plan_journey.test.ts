import { describe, expect, it, vi } from "vitest";
import { makePlanJourneyTool, BUFFER_MINUTES } from "../../src/tools/plan_journey.js";

const j = (legs: any[]) => ({ legs, riskyTransfers: [] });

describe("plan_journey tool", () => {
  it("flags a transfer as risky when gap < BUFFER_MINUTES", async () => {
    const router = {
      searchJourneys: vi.fn().mockResolvedValue({
        data: [
          j([
            {
              trainName: "ICE 597",
              from: { name: "Köln", evaNumber: "8000207" },
              to: { name: "Frankfurt", evaNumber: "8000105" },
              scheduledArrival: "2026-05-15T15:00:00+02:00",
              predictedArrival: "2026-05-15T15:14:00+02:00",
              departureDelayMinutes: 0,
              arrivalDelayMinutes: 14,
              scheduledDeparture: "2026-05-15T14:00:00+02:00",
              predictedDeparture: "2026-05-15T14:00:00+02:00",
            },
            {
              trainName: "ICE 599",
              from: { name: "Frankfurt", evaNumber: "8000105" },
              to: { name: "München", evaNumber: "8000261" },
              scheduledDeparture: "2026-05-15T15:18:00+02:00",
              predictedDeparture: "2026-05-15T15:18:00+02:00",
              scheduledArrival: "2026-05-15T18:30:00+02:00",
              predictedArrival: "2026-05-15T18:30:00+02:00",
              departureDelayMinutes: 0,
              arrivalDelayMinutes: 0,
            },
          ]),
        ],
        source: "marudor",
        degraded: false,
      }),
    } as any;
    const tool = makePlanJourneyTool(router);
    const result = await tool.handler({ fromEva: "8000207", toEva: "8000261" });
    expect(result.data[0].riskyTransfers.length).toBe(1);
    expect(result.data[0].riskyTransfers[0].atStation).toBe("Frankfurt");
  });

  it("does not flag a comfortable transfer", async () => {
    const router = {
      searchJourneys: vi.fn().mockResolvedValue({
        data: [
          j([
            {
              trainName: "A",
              from: { name: "X", evaNumber: "1" },
              to: { name: "Y", evaNumber: "2" },
              scheduledArrival: "2026-05-15T15:00:00+02:00",
              predictedArrival: "2026-05-15T15:02:00+02:00",
              departureDelayMinutes: 0,
              arrivalDelayMinutes: 2,
              scheduledDeparture: "2026-05-15T14:00:00+02:00",
              predictedDeparture: "2026-05-15T14:00:00+02:00",
            },
            {
              trainName: "B",
              from: { name: "Y", evaNumber: "2" },
              to: { name: "Z", evaNumber: "3" },
              scheduledDeparture: "2026-05-15T15:30:00+02:00",
              predictedDeparture: "2026-05-15T15:30:00+02:00",
              scheduledArrival: "2026-05-15T17:00:00+02:00",
              predictedArrival: "2026-05-15T17:00:00+02:00",
              departureDelayMinutes: 0,
              arrivalDelayMinutes: 0,
            },
          ]),
        ],
        source: "marudor",
        degraded: false,
      }),
    } as any;
    const tool = makePlanJourneyTool(router);
    const result = await tool.handler({ fromEva: "1", toEva: "3" });
    expect(result.data[0].riskyTransfers.length).toBe(0);
  });
});
