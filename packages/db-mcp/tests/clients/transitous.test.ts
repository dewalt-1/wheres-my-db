import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../setup.js";
import { TransitousClient } from "../../src/clients/transitous.js";
import { ProviderError } from "../../src/errors.js";
import geocodeFixture from "../fixtures/transitous-geocode.json" with { type: "json" };
import stoptimesFixture from "../fixtures/transitous-stoptimes.json" with { type: "json" };
import tripFixture from "../fixtures/transitous-trip.json" with { type: "json" };
import planFixture from "../fixtures/transitous-plan.json" with { type: "json" };
import mapFixture from "../fixtures/transitous-map-trips.json" with { type: "json" };

const BASE = "https://api.transitous.org";
const KOELN = "de-DELFI_de:05315:11201";
const ICE_107_TRIP = "20261113_08:25_de-DELFI_3478812875";

function isProviderError(kind: string) {
  return (err: unknown) =>
    err instanceof ProviderError && err.source === "transitous" && err.kind === kind;
}

describe("TransitousClient.searchStations", () => {
  it("returns stops with id, name and coordinates, and sends the query", async () => {
    mswServer.use(
      http.get(`${BASE}/api/v1/geocode`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("text")).toBe("Köln Hbf");
        expect(url.searchParams.get("type")).toBe("STOP");
        return HttpResponse.json(geocodeFixture);
      }),
    );
    const stations = await new TransitousClient().searchStations("Köln Hbf");
    expect(stations).toHaveLength(4);
    expect(stations[0]).toEqual({
      id: "be-sncb_8015458",
      name: "Köln Hbf",
      lat: 50.943079999999995,
      lon: 6.95897,
    });
  });

  it("drops entries that are not stops", async () => {
    mswServer.use(
      http.get(`${BASE}/api/v1/geocode`, () =>
        HttpResponse.json([
          { type: "ADDRESS", name: "Bahnhofstraße", id: "x", lat: 1, lon: 2 },
          ...geocodeFixture.slice(0, 1),
        ]),
      ),
    );
    const stations = await new TransitousClient().searchStations("Bahnhof");
    expect(stations.map((s) => s.name)).toEqual(["Köln Hbf"]);
  });
});

describe("TransitousClient.getDepartures", () => {
  it("maps live delay, platform change and trip id", async () => {
    mswServer.use(
      http.get(`${BASE}/api/v5/stoptimes`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("stopId")).toBe(KOELN);
        expect(url.searchParams.get("mode")).toContain("SUBURBAN");
        expect(url.searchParams.get("mode")).not.toContain("BUS");
        return HttpResponse.json(stoptimesFixture);
      }),
    );
    const board = await new TransitousClient().getDepartures(KOELN);
    expect(board).toHaveLength(6);
    const ice107 = board.find((d) => d.trainName === "ICE 107");
    expect(ice107).toMatchObject({
      tripId: ICE_107_TRIP,
      mode: "HIGHSPEED_RAIL",
      delayMinutes: 38,
      track: "6",
      scheduledTrack: "88",
      cancelled: false,
      realTime: true,
    });
    expect(board.find((d) => d.trainName === "RE1 (26814)")?.delayMinutes).toBe(87);
  });

  it("throws a parse error when stopTimes is missing", async () => {
    mswServer.use(http.get(`${BASE}/api/v5/stoptimes`, () => HttpResponse.json({})));
    await expect(new TransitousClient().getDepartures(KOELN)).rejects.toSatisfy(
      isProviderError("parse"),
    );
  });
});

describe("TransitousClient.findTrain", () => {
  const useBoard = () =>
    mswServer.use(
      http.get(`${BASE}/api/v5/stoptimes`, () => HttpResponse.json(stoptimesFixture)),
    );

  it("matches regardless of case and spacing", async () => {
    useBoard();
    const matches = await new TransitousClient().findTrain("ice107", KOELN);
    expect(matches.map((m) => m.tripId)).toEqual([ICE_107_TRIP]);
  });

  it("matches a line name without its run number", async () => {
    useBoard();
    const matches = await new TransitousClient().findTrain("RE1", KOELN);
    expect(matches.map((m) => m.trainName)).toEqual(["RE1 (26814)"]);
  });

  it("does not match a different category with the same number", async () => {
    useBoard();
    await expect(new TransitousClient().findTrain("RB 107", KOELN)).rejects.toSatisfy(
      isProviderError("not_found"),
    );
  });
});

describe("TransitousClient.getTrainStatus", () => {
  it("maps every stop with its arrival delay and platform change", async () => {
    mswServer.use(
      http.get(`${BASE}/api/v5/trip`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("tripId")).toBe(ICE_107_TRIP);
        return HttpResponse.json(tripFixture);
      }),
    );
    const status = await new TransitousClient().getTrainStatus(ICE_107_TRIP);
    expect(status).toMatchObject({
      tripId: ICE_107_TRIP,
      name: "ICE 107",
      mode: "HIGHSPEED_RAIL",
      realTime: true,
      cancelled: false,
    });
    expect(status.stopovers).toHaveLength(12);
    expect(status.stopovers[0].stationName).toBe("Hamburg-Altona");
    expect(status.stopovers[0].arrivalDelayMinutes).toBeUndefined();
    const delays = Object.fromEntries(
      status.stopovers.map((s) => [s.stationName, s.arrivalDelayMinutes]),
    );
    expect(delays["Bremen Hbf"]).toBe(8);
    expect(delays["Düsseldorf Hbf"]).toBe(25);
    expect(delays["Köln Hbf"]).toBe(39);
    const koeln = status.stopovers.find((s) => s.stationName === "Köln Hbf");
    expect(koeln).toMatchObject({ track: "6", scheduledTrack: "88" });
  });

  it("turns alerts into plain text", async () => {
    const withAlert = structuredClone(tripFixture) as { legs: Array<Record<string, unknown>> };
    withAlert.legs[0].alerts = [
      { headerText: "Stellwerksstörung", descriptionText: "Verspätungen im Raum Köln" },
    ];
    mswServer.use(http.get(`${BASE}/api/v5/trip`, () => HttpResponse.json(withAlert)));
    const status = await new TransitousClient().getTrainStatus(ICE_107_TRIP);
    expect(status.alerts).toEqual(["Stellwerksstörung: Verspätungen im Raum Köln"]);
  });

  it("throws not_found when the trip has no legs", async () => {
    mswServer.use(http.get(`${BASE}/api/v5/trip`, () => HttpResponse.json({ legs: [] })));
    await expect(new TransitousClient().getTrainStatus("nope")).rejects.toSatisfy(
      isProviderError("not_found"),
    );
  });
});

describe("TransitousClient.planJourney", () => {
  it("maps legs, including walking legs and live delays", async () => {
    mswServer.use(
      http.get(`${BASE}/api/v5/plan`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("fromPlace")).toBe(KOELN);
        expect(url.searchParams.get("toPlace")).toBe("ffm");
        expect(url.searchParams.get("time")).toBe("2026-11-13T12:00:00Z");
        return HttpResponse.json(planFixture);
      }),
    );
    const options = await new TransitousClient().planJourney(
      KOELN,
      "ffm",
      "2026-11-13T12:00:00Z",
    );
    expect(options).toHaveLength(2);
    const [first] = options[0].legs;
    expect(first).toMatchObject({
      trainName: "ICE 107",
      tripId: ICE_107_TRIP,
      departureDelayMinutes: 40,
      arrivalDelayMinutes: 37,
      realTime: true,
    });
    expect(first.from.name).toBe("Köln Hbf");
    const walk = options[0].legs[1];
    expect(walk.mode).toBe("WALK");
    expect(walk.tripId).toBeUndefined();
  });
});

describe("TransitousClient.getTrainsInArea", () => {
  const box = { minLat: 50.6, minLon: 6.4, maxLat: 51.6, maxLon: 7.8 };

  it("keeps rail only, one entry per trip, with the delay at the next stop", async () => {
    mswServer.use(
      http.get(`${BASE}/api/v5/map/trips`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("min")).toBe("50.6,6.4");
        expect(url.searchParams.get("max")).toBe("51.6,7.8");
        return HttpResponse.json(mapFixture);
      }),
    );
    const trains = await new TransitousClient().getTrainsInArea(box);
    expect(trains.map((t) => t.trainName).sort()).toEqual([
      "RE1 (26814)",
      "RE9 (10916)",
      "S28",
    ]);
    const re1 = trains.find((t) => t.trainName === "RE1 (26814)");
    expect(re1).toMatchObject({
      delayMinutes: 89,
      delayGainedOnSegmentMinutes: 0,
      likelyStuck: false,
    });
    expect(re1?.lat).toBeGreaterThan(50.6);
    expect(re1?.lat).toBeLessThan(51.6);
  });

  it("flags a train losing 10+ minutes between two stops as likelyStuck", async () => {
    const held = structuredClone(mapFixture.slice(2, 3));
    // Left on time, now predicted 12 minutes late at the next stop.
    held[0].scheduledArrival = "2026-11-13T12:33:00Z";
    held[0].arrival = "2026-11-13T12:45:00Z";
    mswServer.use(http.get(`${BASE}/api/v5/map/trips`, () => HttpResponse.json(held)));
    const [train] = await new TransitousClient().getTrainsInArea(box);
    expect(train).toMatchObject({
      trainName: "S28",
      delayMinutes: 12,
      delayGainedOnSegmentMinutes: 12,
      likelyStuck: true,
    });
  });
});

describe("TransitousClient transport errors", () => {
  it("maps HTTP 5xx to an http error", async () => {
    mswServer.use(
      http.get(`${BASE}/api/v1/geocode`, () => new HttpResponse("boom", { status: 503 })),
    );
    await expect(new TransitousClient().searchStations("x")).rejects.toSatisfy(
      isProviderError("http"),
    );
  });

  it("maps a slow response to a timeout error", async () => {
    mswServer.use(
      http.get(`${BASE}/api/v1/geocode`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json([]);
      }),
    );
    await expect(
      new TransitousClient({ timeoutMs: 30 }).searchStations("x"),
    ).rejects.toSatisfy(isProviderError("timeout"));
  });

  it("maps a non-JSON body to a parse error", async () => {
    mswServer.use(
      http.get(`${BASE}/api/v1/geocode`, () => new HttpResponse("<html>", { status: 200 })),
    );
    await expect(new TransitousClient().searchStations("x")).rejects.toSatisfy(
      isProviderError("parse"),
    );
  });

  it("sends the configured User-Agent", async () => {
    let seen: string | null = null;
    mswServer.use(
      http.get(`${BASE}/api/v1/geocode`, ({ request }) => {
        seen = request.headers.get("user-agent");
        return HttpResponse.json([]);
      }),
    );
    await new TransitousClient({ userAgent: "test-agent/1.0" }).searchStations("x");
    expect(seen).toBe("test-agent/1.0");
  });
});
