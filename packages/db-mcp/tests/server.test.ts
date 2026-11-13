import { describe, expect, it, vi } from "vitest";
import { createServer, type TrainData, type WeatherData } from "../src/server.js";
import { ProviderError } from "../src/errors.js";

function stubProviders() {
  const trains = {
    searchStations: vi.fn().mockResolvedValue([{ id: "k", name: "Köln Hbf", lat: 50.94, lon: 6.96 }]),
    getDepartures: vi.fn().mockResolvedValue([]),
    findTrain: vi.fn().mockRejectedValue(new ProviderError("No departure named \"RB 10\"", "transitous", "not_found")),
    getTrainStatus: vi.fn(),
    planJourney: vi.fn(),
    getTrainsInArea: vi.fn().mockResolvedValue([]),
  };
  const weather = { getWarningsNear: vi.fn().mockResolvedValue({ warnings: [] }) };
  return { trains: trains as TrainData & typeof trains, weather: weather as WeatherData & typeof weather };
}

function body(result: { content: unknown[] }) {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe("createServer", () => {
  it("exposes the seven tools", async () => {
    const { listTools } = createServer({ providers: stubProviders() });
    const names = (await listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "find_train",
      "get_departures",
      "get_late_trains",
      "get_train_status",
      "get_weather_risk",
      "plan_journey",
      "resolve_station",
    ]);
  });

  it("dispatches resolve_station and reports the source", async () => {
    const stubs = stubProviders();
    const result = await createServer({ providers: stubs }).callTool("resolve_station", { query: "Koeln" });
    expect(stubs.trains.searchStations).toHaveBeenCalledWith("Koeln");
    expect(body(result)).toEqual({
      data: [{ id: "k", name: "Köln Hbf", lat: 50.94, lon: 6.96 }],
      _meta: { source: "transitous" },
    });
  });

  it("dispatches get_weather_risk to the weather provider", async () => {
    const stubs = stubProviders();
    const result = await createServer({ providers: stubs }).callTool("get_weather_risk", { lat: 50.94, lon: 6.96 });
    expect(stubs.weather.getWarningsNear).toHaveBeenCalledWith({ lat: 50.94, lon: 6.96 }, undefined);
    expect(body(result)._meta.source).toBe("dwd");
  });

  it("turns a provider failure into a readable tool error", async () => {
    const result = await createServer({ providers: stubProviders() }).callTool("find_train", {
      name: "RB 10",
      stationId: "k",
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('No departure named "RB 10"');
  });

  it("returns an error result for an unknown tool", async () => {
    const res = await createServer({ providers: stubProviders() }).callTool("nope", {});
    expect(res.isError).toBe(true);
  });

  it("returns an error result for invalid arguments", async () => {
    const res = await createServer({ providers: stubProviders() }).callTool("resolve_station", { query: "" });
    expect(res.isError).toBe(true);
  });
});
