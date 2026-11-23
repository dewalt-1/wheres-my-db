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
    expect(res.data).toEqual({
      ...status,
      boardingNotices: { status: "off" },
      lineAhead: { status: "not-checked", reason: "Area data unavailable" },
      countries: { status: "not-checked", reason: "Country lookup unavailable" },
      culprit: { status: "not-checked", reason: "Area data unavailable" },
    });
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
    const getBoard = vi.fn().mockResolvedValue([]);
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
      const res = await makeGetTrainStatusTool({ getTrainStatus }, { getNoticesForTrain, getBoard }).handler(at);
      expect(getNoticesForTrain).toHaveBeenCalledWith(koeln, "26814", "2026-11-15T21:37:00Z", undefined);
      expect(res.data.boardingNotices.status).toBe("ok");
      expect(res.diagram).toContain("DB notices at Köln Hbf:\n • Repair to a signal\n • No food or drink available");
    });

    it("keeps working when DB fails, and says why", async () => {
      const getNoticesForTrain = vi.fn().mockRejectedValue(new ProviderError("DB API timed out after 15000ms", "db", "timeout"));
      const res = await makeGetTrainStatusTool({ getTrainStatus }, { getNoticesForTrain, getBoard }).handler(at);
      expect(res.data.boardingNotices).toEqual({ status: "error", station: "Köln Hbf", message: "DB API timed out after 15000ms" });
      expect(res.data.name).toBe("RE1 (26814)");
    });

    it("does not ask DB about trams or U-Bahn", async () => {
      const getNoticesForTrain = vi.fn();
      const tram = vi.fn().mockResolvedValue({ ...status, name: "16", mode: "TRAM" });
      const res = await makeGetTrainStatusTool({ getTrainStatus: tram }, { getNoticesForTrain, getBoard }).handler(at);
      expect(res.data.boardingNotices).toEqual({ status: "not-covered" });
      expect(getNoticesForTrain).not.toHaveBeenCalled();
    });

    it("reports a station DB could not match", async () => {
      const getNoticesForTrain = vi.fn().mockResolvedValue(null);
      const res = await makeGetTrainStatusTool({ getTrainStatus }, { getNoticesForTrain, getBoard }).handler(at);
      expect(res.data.boardingNotices).toEqual({ status: "station-not-found", station: "Köln Hbf" });
    });
  });

  describe("get_train_status line ahead (no DB key needed)", () => {
    const T0 = Date.now();
    const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
    const s = (name: string, lat: number, arr?: number, dep?: number) => ({
      stationName: name, stationId: name, lat, lon: 7, cancelled: false, alerts: [],
      predictedArrival: arr === undefined ? undefined : at(arr), predictedDeparture: dep === undefined ? undefined : at(dep),
      arrivalDelayMinutes: arr === undefined ? undefined : 5,
    });
    const status = {
      tripId: "yours", name: "RE 1", headsign: "D", mode: "REGIONAL_RAIL", realTime: true, cancelled: false, alerts: [],
      stopovers: [s("A", 50.0, undefined, -2), s("B", 50.1, 8, 9), s("C", 50.2, 18, 19), s("D", 50.3, 28)],
    };
    const blocker = {
      tripId: "other", trainName: "RE 5", mode: "REGIONAL_RAIL", fromStation: "B", toStation: "C",
      fromLat: 50.1, fromLon: 7, toLat: 50.2, toLon: 7, predictedDeparture: at(-5), predictedArrival: at(30),
      delayMinutes: 20, lat: 50.12, lon: 7, progress: 0.2, delayGainedOnSegmentMinutes: 15, likelyStuck: true, realTime: true,
    };

    it("asks for the trains around the stretch ahead and reports the hold-up in data and diagram", async () => {
      const getTrainsInArea = vi.fn().mockResolvedValue([blocker]);
      const tool = makeGetTrainStatusTool({ getTrainStatus: vi.fn().mockResolvedValue(status), getTrainsInArea });
      const res = await tool.handler({ tripId: "yours", boardLat: 50.3, boardLon: 7 });
      const box = getTrainsInArea.mock.calls[0][0];
      expect(box.minLat).toBeLessThan(50.0);
      expect(box.maxLat).toBeGreaterThan(50.3);
      expect(res.data.lineAhead).toMatchObject({ status: "held-up", atStation: "D", estimatedDelayMinutes: { low: 20, high: 25 } });
      expect(res.diagram).toContain("Officially 5 min late at D; RE 5 ahead is held near B, so expect about 20–25 min late.");
    });

    it("keeps the train answer when the area lookup fails", async () => {
      const getTrainsInArea = vi.fn().mockRejectedValue(new ProviderError("transitous map/trips timed out", "transitous", "timeout"));
      const tool = makeGetTrainStatusTool({ getTrainStatus: vi.fn().mockResolvedValue(status), getTrainsInArea });
      const res = await tool.handler({ tripId: "yours", boardLat: 50.3, boardLon: 7 });
      expect(res.data.lineAhead).toEqual({ status: "not-checked", reason: "transitous map/trips timed out" });
      expect(res.data.name).toBe("RE 1");
    });

    it("does not guess for trains without live data", async () => {
      const getTrainsInArea = vi.fn();
      const tool = makeGetTrainStatusTool({ getTrainStatus: vi.fn().mockResolvedValue({ ...status, realTime: false }), getTrainsInArea });
      const res = await tool.handler({ tripId: "yours", boardLat: 50.3, boardLon: 7 });
      expect(res.data.lineAhead).toEqual({ status: "not-checked", reason: "No live data for this train" });
      expect(getTrainsInArea).not.toHaveBeenCalled();
    });
  });

  describe("get_train_status: route outside Germany, and what holds the train up", () => {
    // Shaped like ICE 124 on 23 Nov 2026: past Oberhausen, 45 min late at Arnhem.
    const T0 = Date.now();
    const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
    const s = (name: string, id: string, lat: number, dep: number, late = 0) => ({
      stationName: name, stationId: id, lat, lon: 6.5, cancelled: false, alerts: [],
      scheduledArrival: at(dep - 1 - late), scheduledDeparture: at(dep - late),
      predictedArrival: at(dep - 1), predictedDeparture: at(dep), arrivalDelayMinutes: late,
    });
    const route = (offset = 0) => ({
      tripId: "20261123_13:34_de-DELFI_1", name: "ICE 124", trainNumber: "124", headsign: "Amsterdam Centraal", mode: "HIGHSPEED_RAIL",
      realTime: true, cancelled: false, alerts: [],
      path: Array.from({ length: 120 }, (_, i): [number, number] => [50.94 + i * 0.01, 6.5]),
      stopovers: [
        s("Köln Hbf", "de-DELFI_de:05315:11201", 50.94, -100 + offset), s("Oberhausen Hbf", "de-DELFI_de:05119:14022:90:9", 51.47, -60 + offset, 21),
        s("Arnhem Centraal", "de-DELFI_nl:4:18038", 51.98, 20 + offset, 45), s("Utrecht Centraal", "de-DELFI_000008400621", 52.09, 50 + offset, 41),
      ],
    });
    // Stand-in for reverse geocoding: north of 51.9 is the Netherlands here.
    const countryAt = vi.fn(async (lat: number) => (lat > 51.9 ? "NL" : "DE"));
    const local = (over: Record<string, unknown>) => ({
      tripId: "20261123_15:50_de-DELFI_2", trainName: "RE19", mode: "REGIONAL_RAIL", fromStation: "Emmerich", toStation: "Elten",
      fromStopId: "de-DELFI_de:05154:36119", fromLat: 51.83, fromLon: 6.5, toLat: 51.86, toLon: 6.5,
      predictedDeparture: at(-20), predictedArrival: at(5), delayMinutes: 30, lat: 51.84, lon: 6.5, progress: 0.3,
      delayGainedOnSegmentMinutes: 12, likelyStuck: true, realTime: true, ...over,
    });
    const localTrip = (number: string, leftOberhausen: number) => ({ ...route(), name: "RE19", trainNumber: number, stopovers: [s("Oberhausen Hbf", "x", 51.47, leftOberhausen)] });
    const boardTrain = (number: string, causes: number[], disruptions: unknown[] = []) => ({
      journeyId: number, name: "RE19", number, scheduled: at(-30), time: at(-20), cancelled: false, causes, quality: [], disruptions,
    });
    const repairs = { id: "d1", cause: "UNKNOWN_CAUSE", text: "Repairs on several trains of the RE 19." };
    const build = (leftOberhausen: number, causes: number[] = [36], withKey = true) => {
      const getTrainStatus = vi.fn(async (id: string) => (id.endsWith("_1") ? route() : localTrip("20024", leftOberhausen)));
      const getBoard = vi.fn(async () => [
        boardTrain("20024", causes, [repairs]), boardTrain("20029", [36]),
        boardTrain("20030", [], [{ id: "d2", cause: "CONSTRUCTION", text: "Building site until 2027" }]),
      ]);
      const legacy = { getNoticesForTrain: vi.fn().mockResolvedValue({ station: "Arnhem", notices: [{ kind: "delay-reason", text: "Technical fault on another train" }] }) };
      const key = { getNoticesForTrain: vi.fn().mockResolvedValue({ station: "x", notices: [] }), getBoard, legacy };
      return { tool: makeGetTrainStatusTool({ getTrainStatus, countryAt, getTrainsInArea: vi.fn().mockResolvedValue([local({})]) } as never, withKey ? (key as never) : undefined), getBoard, legacy };
    };
    const run = (t: ReturnType<typeof build>) => t.tool.handler({ tripId: "20261123_13:34_de-DELFI_1" });

    it("names the stops outside Germany", async () => {
      const res = await run(build(-75));
      expect(res.data.countries).toEqual({
        status: "crosses-border",
        abroad: [{ country: "NL", countryName: "the Netherlands", stops: ["Arnhem Centraal", "Utrecht Centraal"] }],
      });
      expect(res.diagram).toContain(
        "Outside Germany: Arnhem Centraal → Utrecht Centraal (the Netherlands). German sources have no disruption notices there.",
      );
      expect(res.data).not.toHaveProperty("path");
    });

    it("finds a local train ahead with a fault of its own, though the express skips its stations", async () => {
      const t = build(-75);
      const res = await run(t);
      expect(res.data.culprit).toMatchObject({
        status: "candidates", dbReason: "Technical fault on another train",
        candidates: [{ trainName: "RE19 (20024)", confidence: "likely", where: "Emmerich → Elten" }],
        notices: [{ text: repairs.text }],
      });
      expect(res.data.culprit.otherFaults).toEqual([expect.stringContaining("RE19 (20029): Technical problem with the train")]);
      expect(res.diagram).toContain("What may be holding it up:");
      expect(res.diagram).toContain(" • DB's reason: Technical fault on another train");
      expect(res.diagram).toContain(" • Likely RE19 (20024), Emmerich → Elten: +30 min, DB: Technical problem with the train");
      expect(res.diagram).not.toContain("Building site");
      // German stations only, including one the express passes without stopping.
      expect((t.getBoard.mock.calls as unknown as string[][]).map((c) => c[0])).toEqual(["de:05119:14022", "de:05154:36119"]);
    });

    it("does not blame a train that left after yours", async () => {
      const res = await run(build(-40));
      expect(res.data.culprit).toMatchObject({ status: "none-found", candidates: [], queuedBehind: ["RE19 (20024) +30 min"] });
      expect(res.diagram).toContain(" • No train ahead could be identified as the cause");
    });

    it("goes by DB's recorded departures when the other source has it the wrong way round", async () => {
      const t = build(-75);
      const rec = (number: string, time: string) => ({ ...boardTrain(number, []), time });
      t.getBoard.mockResolvedValue([rec("124", at(-60)), rec("20024", at(-55))]);
      const res = await run(t);
      expect(res.data.culprit).toMatchObject({ status: "none-found", queuedBehind: ["RE19 (20024) +30 min"] });
    });

    it("works without a DB key, with less to go on", async () => {
      const res = await run(build(-75, [], false));
      expect(res.data.culprit).toMatchObject({ status: "candidates", candidates: [{ confidence: "possible" }], notices: [] });
      expect(res.data.boardingNotices).toEqual({ status: "off" });
    });

    it("keeps the answer when a lookup fails, and stays quiet for trains on time", async () => {
      const fail = () => vi.fn().mockRejectedValue(new ProviderError("timed out", "transitous", "timeout"));
      const broken = makeGetTrainStatusTool({ getTrainStatus: vi.fn().mockResolvedValue(route()), countryAt: fail(), getTrainsInArea: fail() });
      const res = await broken.handler({ tripId: "x" });
      expect(res.data.culprit).toEqual({ status: "not-checked", reason: "timed out" });
      expect(res.data.countries).toEqual({ status: "not-checked", reason: "timed out" });
      expect(res.data.name).toBe("ICE 124");
      const onTime = { ...route(), stopovers: route().stopovers.map((x) => ({ ...x, arrivalDelayMinutes: 2 })) };
      const quiet = await makeGetTrainStatusTool({ getTrainStatus: vi.fn().mockResolvedValue(onTime), getTrainsInArea: vi.fn().mockResolvedValue([local({})]) }).handler({ tripId: "x" });
      expect(quiet.data.culprit).toEqual({ status: "not-checked", reason: "Not late enough to look for a cause" });
      expect(quiet.diagram).not.toContain("What may be holding it up");
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
    fromLat: 51, fromLon: 7, toLat: 51.1, toLon: 7,
    predictedDeparture: "2026-11-16T18:00:00Z", predictedArrival: "2026-11-16T18:10:00Z",
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
