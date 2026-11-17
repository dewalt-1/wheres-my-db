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
    const status = { tripId: "t", name: "ICE 1", headsign: "Berlin", mode: "HIGHSPEED_RAIL", realTime: true, cancelled: false, stopovers: [], alerts: [] };
    const getTrainStatus = vi.fn().mockResolvedValue(status);
    const res = await makeGetTrainStatusTool({ getTrainStatus }).handler({ tripId: "t" });
    expect(getTrainStatus).toHaveBeenCalledWith("t");
    expect(res.data).toEqual({ ...status, boardingNotices: { status: "off" } });
    expect(res.diagram).toContain("ICE 1 → Berlin");
    expect(res.mapUrl).toBe("https://dewalt-1.github.io/wheres-my-db/?trip=t");
  });

  it("get_train_status marks the stop nearest to where the user boards", async () => {
    const stop = (name: string, lat: number, lon: number) => ({ stationName: name, stationId: name, lat, lon, cancelled: false, alerts: [] });
    const status = {
      tripId: "t", name: "ICE 107", headsign: "Basel SBB", mode: "HIGHSPEED_RAIL", realTime: true, cancelled: false, alerts: [],
      stopovers: [stop("Düsseldorf Hbf", 51.22, 6.794), stop("Köln Hbf", 50.943, 6.9587), stop("Frankfurt (Main) Flughafen", 50.053, 8.57)],
    };
    const tool = makeGetTrainStatusTool({ getTrainStatus: vi.fn().mockResolvedValue(status) });
    // Station coordinates from a different feed, a few hundred metres off.
    const res = await tool.handler({ tripId: "t", boardLat: 50.9431, boardLon: 6.959 });
    expect(res.mapUrl).toBe("https://dewalt-1.github.io/wheres-my-db/?trip=t&stop=1");
    const boardingLine = res.diagram?.split("\n").find((l) => l.includes("you board here"));
    expect(boardingLine).toContain("Köln Hbf");
  });

  it("get_train_status marks no stop when the given point is not on the route", async () => {
    const status = {
      tripId: "t", name: "ICE 107", headsign: "Basel SBB", mode: "HIGHSPEED_RAIL", realTime: true, cancelled: false, alerts: [],
      stopovers: [{ stationName: "Köln Hbf", stationId: "k", lat: 50.943, lon: 6.9587, cancelled: false, alerts: [] }],
    };
    const tool = makeGetTrainStatusTool({ getTrainStatus: vi.fn().mockResolvedValue(status) });
    const res = await tool.handler({ tripId: "t", boardLat: 52.52, boardLon: 13.37 });
    expect(res.mapUrl).toBe("https://dewalt-1.github.io/wheres-my-db/?trip=t");
    expect(res.diagram).not.toContain("you board here");
  });

  describe("get_train_status DB notices", () => {
    const koeln = { stationName: "Köln Hbf", stationId: "k", lat: 50.943, lon: 6.9587, cancelled: false, alerts: [], scheduledDeparture: "2026-11-15T21:37:00Z" };
    const status = { tripId: "t", name: "RE1 (26814)", trainNumber: "26814", headsign: "Aachen", mode: "REGIONAL_RAIL", realTime: true, cancelled: false, alerts: [], stopovers: [koeln] };
    const getTrainStatus = vi.fn().mockResolvedValue(status);
    const at = { tripId: "t", boardLat: 50.943, boardLon: 6.959 };

    it("reports 'off' when no DB key is configured", async () => {
      const res = await makeGetTrainStatusTool({ getTrainStatus }).handler(at);
      expect(res.data.boardingNotices).toEqual({ status: "off" });
      expect(res.diagram).not.toContain("DB notices");
    });

    it("asks DB for the boarding stop, train number and planned time, and shows the notices", async () => {
      const getNoticesForTrain = vi.fn().mockResolvedValue({
        station: "Köln Hbf",
        notices: [{ kind: "delay-reason", text: "Repair to a signal", code: 34 }, { kind: "quality", text: "No food or drink available", code: 90 }],
      });
      const res = await makeGetTrainStatusTool({ getTrainStatus }, { getNoticesForTrain }).handler(at);
      expect(getNoticesForTrain).toHaveBeenCalledWith("Köln Hbf", "26814", "2026-11-15T21:37:00Z");
      expect(res.data.boardingNotices.status).toBe("ok");
      expect(res.diagram).toContain("DB notices at Köln Hbf:\n • Repair to a signal\n • No food or drink available");
    });

    it("keeps working when DB fails, and says why", async () => {
      const getNoticesForTrain = vi.fn().mockRejectedValue(new ProviderError("DB API timed out after 15000ms", "db", "timeout"));
      const res = await makeGetTrainStatusTool({ getTrainStatus }, { getNoticesForTrain }).handler(at);
      expect(res.data.boardingNotices).toEqual({ status: "error", station: "Köln Hbf", message: "DB API timed out after 15000ms" });
      expect(res.data.name).toBe("RE1 (26814)");
    });

    it("does not ask DB about trams or U-Bahn", async () => {
      const getNoticesForTrain = vi.fn();
      const tram = vi.fn().mockResolvedValue({ ...status, name: "16", mode: "TRAM" });
      const res = await makeGetTrainStatusTool({ getTrainStatus: tram }, { getNoticesForTrain }).handler(at);
      expect(res.data.boardingNotices).toEqual({ status: "not-covered" });
      expect(getNoticesForTrain).not.toHaveBeenCalled();
    });

    it("reports a station DB could not match", async () => {
      const getNoticesForTrain = vi.fn().mockResolvedValue(null);
      const res = await makeGetTrainStatusTool({ getTrainStatus }, { getNoticesForTrain }).handler(at);
      expect(res.data.boardingNotices).toEqual({ status: "station-not-found", station: "Köln Hbf" });
    });
  });

  it("get_train_status needs both boarding coordinates or neither", () => {
    const schema = makeGetTrainStatusTool({} as never).schema;
    expect(() => schema.parse({ tripId: "t", boardLat: 50.9 })).toThrow();
    expect(schema.parse({ tripId: "t" })).toEqual({ tripId: "t" });
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
    progress: 0.5,
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
    expect(res.diagram).toContain("2 of 4 trains late");
    expect(res.mapUrl).toBe("https://dewalt-1.github.io/wheres-my-db/?lat=50.9400&lon=6.9600&r=40&min=5");
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
