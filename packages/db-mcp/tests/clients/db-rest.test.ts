import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mswServer } from "../setup.js";
import { DbRestClient } from "../../src/clients/db-rest.js";
import { ProviderError } from "../../src/errors.js";
import locationsFixture from "../fixtures/dbrest-locations.json" assert { type: "json" };
import journeysFixture from "../fixtures/dbrest-journeys.json" assert { type: "json" };

const BASE_URL = "https://v6.db.transport.rest";

describe("DbRestClient.searchStations", () => {
  it("happy path: returns stations from fixture data", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/locations`, ({ request }) => {
        const query = new URL(request.url).searchParams.get("query");
        expect(query).toBe("Köln Hbf");
        return new HttpResponse(JSON.stringify(locationsFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new DbRestClient({ baseUrl: BASE_URL });
    const stations = await client.searchStations("Köln Hbf");

    expect(stations.length).toBeGreaterThan(0);

    const koeln = stations.find((s) => s.evaNumber === "8000207");
    expect(koeln).toBeDefined();
    expect(koeln?.name).toBe("Köln Hbf");

    // All returned stations must have evaNumber and name
    for (const s of stations) {
      expect(s.evaNumber).toBeTruthy();
      expect(s.name).toBeTruthy();
    }
  });

  it("filters by type === station or stop", async () => {
    const mixedFixture = [
      { type: "station", id: "1", name: "Station A" },
      { type: "stop", id: "2", name: "Stop B" },
      { type: "address", id: "3", name: "Address C" },
      { type: "poi", id: "4", name: "POI D" },
    ];

    mswServer.use(
      http.get(`${BASE_URL}/locations`, () => {
        return new HttpResponse(JSON.stringify(mixedFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new DbRestClient({ baseUrl: BASE_URL });
    const stations = await client.searchStations("test");

    expect(stations).toHaveLength(2);
    expect(stations.map((s) => s.name)).toEqual(["Station A", "Stop B"]);
  });

  it("failure path: throws ProviderError with kind=http on 503", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/locations`, () => {
        return new HttpResponse("Service Unavailable", { status: 503 });
      }),
    );

    const client = new DbRestClient({ baseUrl: BASE_URL });
    await expect(client.searchStations("Köln Hbf")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.kind === "http" &&
        err.source === "db-rest",
    );
  });

  it("throws ProviderError with kind=parse on invalid JSON", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/locations`, () => {
        return new HttpResponse("not valid json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new DbRestClient({ baseUrl: BASE_URL });
    await expect(client.searchStations("test")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.kind === "parse" &&
        err.source === "db-rest",
    );
  });

  it("throws ProviderError with kind=timeout on timeout", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/locations`, async () => {
        // Delay longer than timeout
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new HttpResponse(JSON.stringify(locationsFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new DbRestClient({ baseUrl: BASE_URL, timeoutMs: 20 });
    await expect(client.searchStations("test")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.kind === "timeout" &&
        err.source === "db-rest",
    );
  });
});

describe("DbRestClient.searchJourneys", () => {
  it("happy path: returns JourneyOption[] with legs mapped from fixture", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/journeys`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("from")).toBe("8098160");
        expect(url.searchParams.get("to")).toBe("8011113");
        return new HttpResponse(JSON.stringify(journeysFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new DbRestClient({ baseUrl: BASE_URL });
    const options = await client.searchJourneys("8098160", "8011113");

    expect(options.length).toBeGreaterThan(0);

    const option = options[0];
    expect(option.legs.length).toBeGreaterThan(0);
    expect(option.riskyTransfers).toEqual([]);

    const leg = option.legs[0];
    expect(leg.trainName).toBe("ICE 597");
    expect(leg.from.evaNumber).toBe("8098160");
    expect(leg.from.name).toBe("Berlin Hbf");
    expect(leg.to.evaNumber).toBe("8011113");
    expect(leg.to.name).toBe("Berlin Südkreuz");
    expect(leg.scheduledDeparture).toBe("2026-05-18T07:27:00.000Z");
    expect(leg.predictedDeparture).toBe("2026-05-18T07:27:00.000Z");
    expect(leg.scheduledArrival).toBe("2026-05-18T07:33:00.000Z");
    expect(leg.predictedArrival).toBe("2026-05-18T07:33:00.000Z");
    expect(leg.departureDelayMinutes).toBe(0);
    expect(leg.arrivalDelayMinutes).toBe(0);
  });

  it("filters out walking legs", async () => {
    const withWalkingFixture = {
      journeys: [
        {
          legs: [
            {
              line: { name: "ICE 597" },
              origin: { id: "1", name: "Station A" },
              destination: { id: "2", name: "Station B" },
              plannedDeparture: "2026-05-18T07:27:00Z",
              plannedArrival: "2026-05-18T07:33:00Z",
              departureDelay: 0,
              arrivalDelay: 0,
              walking: false,
            },
            {
              line: { name: "Walk" },
              origin: { id: "2", name: "Station B" },
              destination: { id: "3", name: "Station C" },
              plannedDeparture: "2026-05-18T07:35:00Z",
              plannedArrival: "2026-05-18T07:45:00Z",
              departureDelay: 0,
              arrivalDelay: 0,
              walking: true,
            },
          ],
        },
      ],
    };

    mswServer.use(
      http.get(`${BASE_URL}/journeys`, () => {
        return new HttpResponse(JSON.stringify(withWalkingFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new DbRestClient({ baseUrl: BASE_URL });
    const options = await client.searchJourneys("1", "3");

    expect(options[0].legs).toHaveLength(1);
    expect(options[0].legs[0].trainName).toBe("ICE 597");
  });

  it("handles delay in seconds and converts to minutes", async () => {
    const delayFixture = {
      journeys: [
        {
          legs: [
            {
              line: { name: "ICE 597" },
              origin: { id: "1", name: "A" },
              destination: { id: "2", name: "B" },
              plannedDeparture: "2026-05-18T07:27:00Z",
              plannedArrival: "2026-05-18T07:33:00Z",
              departureDelay: 180, // 3 minutes in seconds
              arrivalDelay: 120, // 2 minutes in seconds
              walking: false,
            },
          ],
        },
      ],
    };

    mswServer.use(
      http.get(`${BASE_URL}/journeys`, () => {
        return new HttpResponse(JSON.stringify(delayFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new DbRestClient({ baseUrl: BASE_URL });
    const options = await client.searchJourneys("1", "2");

    expect(options[0].legs[0].departureDelayMinutes).toBe(3);
    expect(options[0].legs[0].arrivalDelayMinutes).toBe(2);
  });

  it("with isoTime parameter", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/journeys`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("departure")).toBe("2026-05-18T07:27:00Z");
        return new HttpResponse(JSON.stringify(journeysFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new DbRestClient({ baseUrl: BASE_URL });
    await client.searchJourneys("8098160", "8011113", "2026-05-18T07:27:00Z");
  });

  it("upstream 500: bubbles ProviderError with kind=http", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/journeys`, () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }),
    );

    const client = new DbRestClient({ baseUrl: BASE_URL });
    await expect(
      client.searchJourneys("8098160", "8011113"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.kind === "http" &&
        err.source === "db-rest",
    );
  });
});

describe("DbRestClient.getDisruptions", () => {
  it("returns [] without making any request", async () => {
    // No MSW handler registered — if a call happens, it will fail
    const client = new DbRestClient({ baseUrl: BASE_URL });
    const disruptions = await client.getDisruptions({});

    expect(disruptions).toEqual([]);
  });
});

describe("DbRestClient.getTrainDetails", () => {
  it("throws ProviderError with kind=not_found", async () => {
    const client = new DbRestClient({ baseUrl: BASE_URL });

    await expect(client.getTrainDetails("ICE 597")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.kind === "not_found" &&
        err.source === "db-rest",
    );
  });
});
