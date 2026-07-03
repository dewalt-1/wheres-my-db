import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../setup.js";
import { WeatherClient } from "../../src/clients/weather.js";
import { ProviderError } from "../../src/errors.js";
import dwdFixture from "../fixtures/dwd-warnings.json" with { type: "json" };
import dwdEmptyFixture from "../fixtures/dwd-warnings-empty.json" with { type: "json" };

const BASE_URL = "https://www.dwd.de";
const WFS_BASE_URL = "https://maps.dwd.de";

// DWD returns JSONP — wrap the fixture as the real endpoint would.
function jsonpWrap(obj: unknown): string {
  return `warnWetter.loadWarnings(${JSON.stringify(obj)});`;
}

// Station resolver fake — returns Köln Hbf coordinates for any evaNumber.
const koelnHbf = { lat: 50.9429, lon: 6.9582, name: "Köln Hbf" };
function fakeResolver(_eva: string) {
  return Promise.resolve(koelnHbf);
}

// WFS GeoJSON stub: polygon centroids for the three warncell IDs in the fixture.
//
// - 109184000  Bayern / München:          centroid ~(48.137, 11.576)  — ~477 km from Köln
// - 101061000  Schleswig-Holstein / SH:   centroid ~(53.952,  9.533)  — ~352 km from Köln
// - 105313000  NRW / Stadt Köln:          centroid ~(50.938,  6.960)  — ~0.7 km from Köln
//
// Each polygon is a tiny square around the centroid; actual shape doesn't
// matter because we use centroid haversine, not point-in-polygon.
function makeWfsStub() {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { WARNCELLID: 109184000, NAME: "München", BL: "BY" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [11.576, 48.137],
              [11.577, 48.137],
              [11.577, 48.138],
              [11.576, 48.138],
              [11.576, 48.137],
            ],
          ],
        },
      },
      {
        type: "Feature",
        properties: { WARNCELLID: 101061000, NAME: "Kreis Steinburg", BL: "SH" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [9.533, 53.952],
              [9.534, 53.952],
              [9.534, 53.953],
              [9.533, 53.953],
              [9.533, 53.952],
            ],
          ],
        },
      },
      {
        type: "Feature",
        properties: { WARNCELLID: 105313000, NAME: "Stadt Köln", BL: "NW" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [6.960, 50.938],
              [6.961, 50.938],
              [6.961, 50.939],
              [6.960, 50.939],
              [6.960, 50.938],
            ],
          ],
        },
      },
    ],
  };
}

// Match only the WFS path; MSW recommends matching paths without query strings.
const WFS_PATH = `${WFS_BASE_URL}/geoserver/dwd/ows`;

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
      http.get(WFS_PATH, () => HttpResponse.json(makeWfsStub())),
    );

    const client = new WeatherClient({
      baseUrl: BASE_URL,
      wfsBaseUrl: WFS_BASE_URL,
      stationResolver: fakeResolver,
    });
    // Use an explicit atTime in the middle of July 2026 so the time filter is
    // deterministic regardless of when this test runs.
    const result = await client.getWarningsForStation(
      "8000207",
      "2026-07-15T12:00:00.000Z",
    );

    expect(result.stationCoordinates).toEqual(koelnHbf);
    expect(Array.isArray(result.warnings)).toBe(true);
    // Only the NRW / Stadt Köln warning should survive coordinate filtering.
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

describe("WeatherClient filtering", () => {
  it("returns empty array when DWD has no active warnings", async () => {
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        () =>
          new HttpResponse(jsonpWrap(dwdEmptyFixture), {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      ),
      http.get(WFS_PATH, () => HttpResponse.json(makeWfsStub())),
    );

    const client = new WeatherClient({
      baseUrl: BASE_URL,
      wfsBaseUrl: WFS_BASE_URL,
      stationResolver: fakeResolver,
    });
    const result = await client.getWarningsForStation("8000207");
    expect(result.warnings).toEqual([]);
  });

  it("atTime in the future drops warnings whose end is before it", async () => {
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        () =>
          new HttpResponse(jsonpWrap(dwdFixture), {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      ),
      http.get(WFS_PATH, () => HttpResponse.json(makeWfsStub())),
    );

    const client = new WeatherClient({
      baseUrl: BASE_URL,
      wfsBaseUrl: WFS_BASE_URL,
      stationResolver: fakeResolver,
    });
    // Far future: every warning in the fixture should have ended.
    const result = await client.getWarningsForStation(
      "8000207",
      "2099-12-31T00:00:00.000Z",
    );
    expect(result.warnings).toEqual([]);
  });

  it("coordinate radius filter drops warnings far from the station", async () => {
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        () =>
          new HttpResponse(jsonpWrap(dwdFixture), {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      ),
      http.get(WFS_PATH, () => HttpResponse.json(makeWfsStub())),
    );

    // Resolver returns a station on a different continent.
    const farResolver = () =>
      Promise.resolve({ lat: -33.8688, lon: 151.2093, name: "Sydney Hbf" });
    const client = new WeatherClient({
      baseUrl: BASE_URL,
      wfsBaseUrl: WFS_BASE_URL,
      stationResolver: farResolver,
      radiusKm: 25,
    });
    // Use atTime within the fixture's active window so time filter passes;
    // only the coordinate filter should drop the warnings.
    const result = await client.getWarningsForStation(
      "8000207",
      "2026-07-15T12:00:00.000Z",
    );
    expect(result.warnings).toEqual([]);
  });
});

describe("WeatherClient error paths", () => {
  it("does not poison the cache if WFS fails with 5xx", async () => {
    // First call: WFS returns 503 → no filtering, all warnings returned
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        () =>
          new HttpResponse(jsonpWrap(dwdFixture), {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      ),
      http.get(WFS_PATH, () => new HttpResponse("boom", { status: 503 })),
    );
    const client = new WeatherClient({
      baseUrl: BASE_URL,
      wfsBaseUrl: WFS_BASE_URL,
      stationResolver: fakeResolver,
    });
    const first = await client.getWarningsForStation(
      "8000207",
      "2026-07-15T12:00:00.000Z",
    );
    // Without coordinate filtering, all warnings in the fixture are kept
    expect(first.warnings.length).toBe(3);

    // Second call: WFS now succeeds, filtering should kick in
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        () =>
          new HttpResponse(jsonpWrap(dwdFixture), {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      ),
      http.get(WFS_PATH, () => HttpResponse.json(makeWfsStub())),
    );
    const second = await client.getWarningsForStation(
      "8000207",
      "2026-07-15T12:00:00.000Z",
    );
    // Now coordinate filtering works: only Köln-area warning survives
    expect(second.warnings.length).toBe(1);
  });

  it("does not poison the cache if WFS times out", async () => {
    // First call: WFS times out → no filtering, all warnings returned
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        () =>
          new HttpResponse(jsonpWrap(dwdFixture), {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      ),
      http.get(WFS_PATH, async () => {
        // Delay longer than the client's timeoutMs
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json(makeWfsStub());
      }),
    );
    const client = new WeatherClient({
      baseUrl: BASE_URL,
      wfsBaseUrl: WFS_BASE_URL,
      stationResolver: fakeResolver,
      timeoutMs: 50,
    });
    const first = await client.getWarningsForStation(
      "8000207",
      "2026-07-15T12:00:00.000Z",
    );
    // Without coordinate filtering, all warnings in the fixture are kept
    expect(first.warnings.length).toBe(3);

    // Second call: WFS now succeeds, filtering should kick in
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        () =>
          new HttpResponse(jsonpWrap(dwdFixture), {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      ),
      http.get(WFS_PATH, () => HttpResponse.json(makeWfsStub())),
    );
    const second = await client.getWarningsForStation(
      "8000207",
      "2026-07-15T12:00:00.000Z",
    );
    // Now coordinate filtering works: only Köln-area warning survives
    expect(second.warnings.length).toBe(1);
  });

  it("throws ProviderError(http) on HTTP 5xx", async () => {
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        () => new HttpResponse("upstream boom", { status: 503 }),
      ),
      http.get(WFS_PATH, () => HttpResponse.json(makeWfsStub())),
    );
    const client = new WeatherClient({
      baseUrl: BASE_URL,
      stationResolver: fakeResolver,
    });
    await expect(
      client.getWarningsForStation("8000207"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.source === "dwd" &&
        err.kind === "http",
    );
  });

  it("throws ProviderError(timeout) when the request exceeds timeoutMs", async () => {
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        async () => {
          // Delay longer than the client's timeoutMs.
          await new Promise((r) => setTimeout(r, 200));
          return new HttpResponse(jsonpWrap(dwdFixture), { status: 200 });
        },
      ),
      http.get(WFS_PATH, () => HttpResponse.json(makeWfsStub())),
    );
    const client = new WeatherClient({
      baseUrl: BASE_URL,
      stationResolver: fakeResolver,
      timeoutMs: 50,
    });
    await expect(
      client.getWarningsForStation("8000207"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.source === "dwd" &&
        err.kind === "timeout",
    );
  });

  it("throws ProviderError(parse) on non-JSON body", async () => {
    mswServer.use(
      http.get(
        `${BASE_URL}/DWD/warnungen/warnapp/json/warnings.json`,
        () =>
          new HttpResponse("warnWetter.loadWarnings(not-json-at-all);", {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      ),
      http.get(WFS_PATH, () => HttpResponse.json(makeWfsStub())),
    );
    const client = new WeatherClient({
      baseUrl: BASE_URL,
      stationResolver: fakeResolver,
    });
    await expect(
      client.getWarningsForStation("8000207"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.source === "dwd" &&
        err.kind === "parse",
    );
  });

  it("throws ProviderError(not_found) when stationResolver throws", async () => {
    // Note: WeatherClient does not currently translate resolver errors —
    // it lets them propagate. This test confirms behavior. If translation
    // is desired (e.g., wrap into ProviderError(not_found)), update the
    // client in this step and adjust the assertion.
    mswServer.use(
      http.get(WFS_PATH, () => HttpResponse.json(makeWfsStub())),
    );
    const failingResolver = () =>
      Promise.reject(
        new ProviderError("station not found", "dwd", "not_found"),
      );
    const client = new WeatherClient({
      baseUrl: BASE_URL,
      stationResolver: failingResolver,
    });
    await expect(
      client.getWarningsForStation("nonexistent"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.source === "dwd" &&
        err.kind === "not_found",
    );
  });
});
