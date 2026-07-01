import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../setup.js";
import { WeatherClient } from "../../src/clients/weather.js";
import dwdFixture from "../fixtures/dwd-warnings.json" with { type: "json" };

const BASE_URL = "https://www.dwd.de";

// DWD returns JSONP — wrap the fixture as the real endpoint would.
function jsonpWrap(obj: unknown): string {
  return `warnWetter.loadWarnings(${JSON.stringify(obj)});`;
}

// Station resolver fake — returns a fixed coordinate for any evaNumber.
const koelnHbf = { lat: 50.9429, lon: 6.9582, name: "Köln Hbf" };
function fakeResolver(_eva: string) {
  return Promise.resolve(koelnHbf);
}

describe("WeatherClient.getWarningsForStation", () => {
  it("happy path: returns mapped warnings for a station", async () => {
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        () =>
          new HttpResponse(jsonpWrap(dwdFixture), {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      ),
    );

    const client = new WeatherClient({
      baseUrl: BASE_URL,
      stationResolver: fakeResolver,
    });
    const result = await client.getWarningsForStation("8000207");

    expect(result.stationCoordinates).toEqual(koelnHbf);
    expect(Array.isArray(result.warnings)).toBe(true);
    // At least one warning should make it through the (currently no-op) filter.
    expect(result.warnings.length).toBeGreaterThan(0);
    const w = result.warnings[0];
    expect(typeof w.type).toBe("string");
    expect([1, 2, 3, 4]).toContain(w.level);
    expect(typeof w.headline).toBe("string");
    // start/end are mapped from epoch ms to ISO 8601 strings.
    expect(w.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(w.end).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
