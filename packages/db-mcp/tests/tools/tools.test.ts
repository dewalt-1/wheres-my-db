import { describe, expect, it, vi } from "vitest";
import { makeResolveStationTool } from "../../src/tools/resolve_station.js";
import { makeGetDeparturesTool } from "../../src/tools/get_departures.js";
import { makeFindTrainTool } from "../../src/tools/find_train.js";
import { makeGetTrainStatusTool } from "../../src/tools/get_train_status.js";
import { makePlanJourneyTool } from "../../src/tools/plan_journey.js";
import { makeGetLateTrainsTool } from "../../src/tools/get_late_trains.js";
import { makeGetWeatherRiskTool } from "../../src/tools/get_weather_risk.js";
import { ProviderError } from "../../src/errors.js";
import type { JourneyLeg, TrainInArea } from "../../src/types.js";

describe("pass-through tools", () => {
  it("resolve_station forwards the query and labels the source", async () => {
    const searchStations = vi.fn().mockResolvedValue([{ id: "a", name: "Köln Hbf", lat: 1, lon: 2 }]);
    const res = await makeResolveStationTool({ searchStations }).handler({ query: "Koeln" });
    expect(searchStations).toHaveBeenCalledWith("Koeln");
    expect(res).toEqual({ data: [{ id: "a", name: "Köln Hbf", lat: 1, lon: 2 }], source: "transitous" });
  });

  it("get_departures forwards station, time and limit", async () => {
    const getDepartures = vi.fn().mockResolvedValue([]);
    await makeGetDeparturesTool({ getDepartures }).handler({ stationId: "s", time: "t", limit: 10 });
    expect(getDepartures).toHaveBeenCalledWith("s", { time: "t", limit: 10 });
  });

  it("find_train forwards name, station and time", async () => {
    const findTrain = vi.fn().mockResolvedValue([]);
    await makeFindTrainTool({ findTrain }).handler({ name: "ICE 107", stationId: "s" });
    expect(findTrain).toHaveBeenCalledWith("ICE 107", "s", undefined);
  });

  it("get_train_status forwards the trip id", async () => {
    const getTrainStatus = vi.fn().mockResolvedValue({ tripId: "t" });
    const res = await makeGetTrainStatusTool({ getTrainStatus }).handler({ tripId: "t" });
    expect(getTrainStatus).toHaveBeenCalledWith("t");
    expect(res.data).toEqual({ tripId: "t" });
  });

  it("each tool rejects empty required input", () => {
    expect(() => makeResolveStationTool({} as never).schema.parse({ query: "" })).toThrow();
    expect(() => makeGetDeparturesTool({} as never).schema.parse({})).toThrow();
    expect(() => makeFindTrainTool({} as never).schema.parse({ name: "ICE 1" })).toThrow();
    expect(() => makeGetTrainStatusTool({} as never).schema.parse({ tripId: "" })).toThrow();
    expect(() => makeGetLateTrainsTool({} as never).schema.parse({ lat: 95, lon: 0 })).toThrow();
  });
});

function leg(over: Partial<JourneyLeg>): JourneyLeg {
  const at = (name: string) => ({ id: name, name, lat: 0, lon: 0 });
  return {
    trainName: "X",
    mode: "REGIONAL_RAIL",
    tripId: "trip",
    from: at("A"),
    to: at("B"),
    scheduledDeparture: "2026-11-13T12:00:00Z",
    predictedDeparture: "2026-11-13T12:00:00Z",
    scheduledArrival: "2026-11-13T13:00:00Z",
    predictedArrival: "2026-11-13T13:00:00Z",
    departureDelayMinutes: 0,
    arrivalDelayMinutes: 0,
    cancelled: false,
    realTime: true,
    ...over,
  };
}

describe("plan_journey tool", () => {
  const walk = leg({ trainName: "WALK", mode: "WALK", tripId: undefined });

  it("flags a transfer with under 5 minutes between trains, looking past the walking leg", async () => {
    const planJourney = vi.fn().mockResolvedValue([
      {
        legs: [
          leg({ trainName: "S11", to: { id: "d", name: "Köln Messe/Deutz", lat: 0, lon: 0 }, predictedArrival: "2026-11-13T12:43:00Z" }),
          walk,
          leg({ trainName: "ICE 919", predictedDeparture: "2026-11-13T12:46:00Z" }),
        ],
        riskyTransfers: [],
      },
    ]);
    const res = await makePlanJourneyTool({ planJourney }).handler({ fromStationId: "a", toStationId: "b" });
    expect(planJourney).toHaveBeenCalledWith("a", "b", undefined);
    expect(res.data[0].riskyTransfers).toHaveLength(1);
    expect(res.data[0].riskyTransfers[0].atStation).toBe("Köln Messe/Deutz");
    expect(res.data[0].riskyTransfers[0].reason).toContain("Only 3 min");
  });

  it("does not flag a comfortable transfer", async () => {
    const planJourney = vi.fn().mockResolvedValue([
      {
        legs: [
          leg({ predictedArrival: "2026-11-13T13:28:00Z" }),
          walk,
          leg({ predictedDeparture: "2026-11-13T13:45:00Z" }),
        ],
        riskyTransfers: [],
      },
    ]);
    const res = await makePlanJourneyTool({ planJourney }).handler({ fromStationId: "a", toStationId: "b" });
    expect(res.data[0].riskyTransfers).toEqual([]);
  });
});

function train(name: string, delayMinutes: number): TrainInArea {
  return {
    tripId: name,
    trainName: name,
    mode: "REGIONAL_RAIL",
    fromStation: "A",
    toStation: "B",
    delayMinutes,
    lat: 51,
    lon: 7,
    delayGainedOnSegmentMinutes: 0,
    likelyStuck: false,
    realTime: true,
  };
}

describe("get_late_trains tool", () => {
  it("filters by minimum delay, sorts worst first and reports how many trains were checked", async () => {
    const getTrainsInArea = vi
      .fn()
      .mockResolvedValue([train("on-time", 0), train("a-bit", 6), train("very", 40), train("slightly", 4)]);
    const res = await makeGetLateTrainsTool({ getTrainsInArea }).handler({ lat: 50.94, lon: 6.96 });
    expect(res.data.trainsChecked).toBe(4);
    expect(res.data.lateTrains.map((t) => t.trainName)).toEqual(["very", "a-bit"]);
  });

  it("turns centre + radius into a bounding box around the point", async () => {
    const getTrainsInArea = vi.fn().mockResolvedValue([]);
    await makeGetLateTrainsTool({ getTrainsInArea }).handler({ lat: 50, lon: 7, radiusKm: 111 });
    const box = getTrainsInArea.mock.calls[0][0];
    expect(box.minLat).toBeCloseTo(49, 5);
    expect(box.maxLat).toBeCloseTo(51, 5);
    // A degree of longitude is shorter than a degree of latitude at 50°N.
    expect(box.maxLon - box.minLon).toBeGreaterThan(2);
    expect((box.minLon + box.maxLon) / 2).toBeCloseTo(7, 5);
  });
});

describe("get_weather_risk tool", () => {
  it("forwards the point and time and returns the warnings", async () => {
    const getWarningsNear = vi.fn().mockResolvedValue({ warnings: [{ type: "HITZE", level: 3 }] });
    const res = await makeGetWeatherRiskTool({ getWarningsNear }).handler({ lat: 50.9, lon: 6.9, atTime: "t" });
    expect(getWarningsNear).toHaveBeenCalledWith({ lat: 50.9, lon: 6.9 }, "t");
    expect(res).toEqual({ data: { warnings: [{ type: "HITZE", level: 3 }] }, source: "dwd" });
  });

  it("soft-fails to warningsUnavailable when the weather service errors", async () => {
    const getWarningsNear = vi.fn().mockRejectedValue(new ProviderError("down", "dwd", "http"));
    const res = await makeGetWeatherRiskTool({ getWarningsNear }).handler({ lat: 1, lon: 2 });
    expect(res.data).toEqual({ warnings: [], warningsUnavailable: true });
  });

  it("re-throws anything that is not a provider error", async () => {
    const getWarningsNear = vi.fn().mockRejectedValue(new Error("bug"));
    await expect(makeGetWeatherRiskTool({ getWarningsNear }).handler({ lat: 1, lon: 2 })).rejects.toThrow("bug");
  });
});
