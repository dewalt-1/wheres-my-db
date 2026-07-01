import { describe, expect, it, vi } from "vitest";
import { makeGetWeatherRiskTool } from "../../src/tools/get_weather_risk.js";
import { ProviderError } from "../../src/errors.js";

const koeln = { lat: 50.9429, lon: 6.9582, name: "Köln Hbf" };

describe("get_weather_risk tool", () => {
  it("passes evaNumber and atTime through to the client and wraps the result", async () => {
    const client = {
      getWarningsForStation: vi.fn().mockResolvedValue({
        stationCoordinates: koeln,
        warnings: [
          {
            type: "HITZE",
            level: 3,
            headline: "Amtliche WARNUNG vor HITZE",
            description: "...",
            start: "2026-06-30T08:00:00.000Z",
            end: "2026-06-30T18:00:00.000Z",
            areaName: "Stadt Köln",
          },
        ],
      }),
    } as any;
    const tool = makeGetWeatherRiskTool(client);
    const result = await tool.handler({
      evaNumber: "8000207",
      atTime: "2026-06-30T12:00:00.000Z",
    });
    expect(client.getWarningsForStation).toHaveBeenCalledWith(
      "8000207",
      "2026-06-30T12:00:00.000Z",
    );
    expect(result.source).toBe("dwd");
    expect(result.degraded).toBe(false);
    expect(result.data.warnings).toHaveLength(1);
    expect(result.data.warnings[0].type).toBe("HITZE");
    expect(result.data.stationCoordinates).toEqual(koeln);
    expect(result.data.warningsUnavailable).toBeUndefined();
  });

  it("works without atTime", async () => {
    const client = {
      getWarningsForStation: vi.fn().mockResolvedValue({
        stationCoordinates: koeln,
        warnings: [],
      }),
    } as any;
    const tool = makeGetWeatherRiskTool(client);
    const result = await tool.handler({ evaNumber: "8000207" });
    expect(client.getWarningsForStation).toHaveBeenCalledWith(
      "8000207",
      undefined,
    );
    expect(result.data.warnings).toEqual([]);
  });

  it("soft-fails to warningsUnavailable when the client throws ProviderError", async () => {
    const client = {
      getWarningsForStation: vi
        .fn()
        .mockRejectedValue(new ProviderError("dwd down", "dwd", "http")),
    } as any;
    const tool = makeGetWeatherRiskTool(client);
    const result = await tool.handler({ evaNumber: "8000207" });
    expect(result.source).toBe("dwd");
    expect(result.degraded).toBe(false);
    expect(result.data.warnings).toEqual([]);
    expect(result.data.warningsUnavailable).toBe(true);
    // stationCoordinates is best-effort — may be a zero placeholder.
    expect(result.data.stationCoordinates).toBeDefined();
  });

  it("rejects invalid input via zod", () => {
    const tool = makeGetWeatherRiskTool({} as any);
    expect(() => tool.schema.parse({})).toThrow();
    expect(() => tool.schema.parse({ evaNumber: "" })).toThrow();
  });
});
