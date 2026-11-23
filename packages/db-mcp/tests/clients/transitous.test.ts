import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../setup.js";
import { TransitousClient } from "../../src/clients/transitous.js";
import { ProviderError } from "../../src/errors.js";
import geocodeFixture from "../fixtures/transitous-geocode.json" with { type: "json" };
import stoptimesFixture from "../fixtures/transitous-stoptimes.json" with { type: "json" };
import ice224Board from "../fixtures/transitous-stoptimes-ice224.json" with { type: "json" };
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

  it("returns one record per run, the one with live data, when feeds duplicate a train", async () => {
    // Recorded board: a cross-border ICE listed by two feeds, the
    // timetable-only record first and the live one second.
    mswServer.use(
      http.get(`${BASE}/api/v5/stoptimes`, () => HttpResponse.json(ice224Board)),
    );
    const matches = await new TransitousClient().findTrain("ICE 224", KOELN);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      tripId: "20261117_14:20_nl-OpenOV_364523750",
      realTime: true,
      cancelled: true,
      delayMinutes: 31,
    });
  });

  describe("duplicate records of one train", () => {
    const entry = (tripId: string, name: string, headsign: string, sched: string, pred: string, realTime = true) => ({
      tripId, displayName: name, headsign, mode: "HIGHSPEED_RAIL", realTime,
      place: { name: "Düsseldorf Hbf", scheduledDeparture: sched, departure: pred },
    });
    const board = (...stopTimes: unknown[]) =>
      mswServer.use(http.get(`${BASE}/api/v5/stoptimes`, () => HttpResponse.json({ stopTimes })));
    const ids = async () => (await new TransitousClient().getDepartures(KOELN)).map((d) => d.tripId);
    const dutch = entry("20261123_13:34_nl-OpenOV_381860864", "ICE 124", "Amsterdam Centraal", "2026-11-23T14:12:00Z", "2026-11-23T14:12:00Z");
    const german = entry("20261123_13:34_de-DELFI_3490186591", "ICE 124", "Amsterdam Centraal", "2026-11-23T14:11:00Z", "2026-11-23T14:28:00Z");

    it("prefers the live German record, whichever comes first, even when timetables differ by a minute", async () => {
      board(dutch, german);
      expect(await ids()).toEqual([german.tripId]);
      board(german, dutch);
      expect(await ids()).toEqual([german.tripId]);
    });

    it("falls back to another country's record when the German one has no live data", async () => {
      board({ ...german, realTime: false }, dutch);
      expect(await ids()).toEqual([dutch.tripId]);
    });

    it("keeps two trains of one line that leave in the same minute", async () => {
      // Real board at Köln: both directions of the S12 at 16:10.
      board(
        entry("20261123_15:20_de-DELFI_1", "S12", "Hennef Bf", "2026-11-23T16:10:00Z", "2026-11-23T16:10:00Z"),
        entry("20261123_15:20_de-DELFI_2", "S12", "Kerpen Horrem Bf", "2026-11-23T16:10:00Z", "2026-11-23T16:10:00Z"),
      );
      expect(await ids()).toHaveLength(2);
    });

    it("keeps different runs of a line that two feeds both carry", async () => {
      board(
        entry("20261123_15:20_de-DELFI_1", "RE19", "Arnhem Centraal", "2026-11-23T16:10:00Z", "2026-11-23T16:10:00Z"),
        entry("20261123_15:50_nl-OpenOV_2", "RE19", "Düsseldorf Hbf", "2026-11-23T16:10:00Z", "2026-11-23T16:10:00Z"),
      );
      expect(await ids()).toHaveLength(2);
    });
  });

  it("searches a window wide enough to reach a train that is hours late", async () => {
    // The board is sorted by actual departure. With a fixed number of entries,
    // a train running 30+ min late fell past the end and only its
    // timetable-only twin was found. Ask for a time window instead.
    let query: URLSearchParams | undefined;
    mswServer.use(
      http.get(`${BASE}/api/v5/stoptimes`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json(ice224Board);
      }),
    );
    await new TransitousClient().findTrain("ICE 224", KOELN, "2026-11-17T18:00:00Z");
    expect(query?.get("time")).toBe("2026-11-17T15:00:00.000Z"); // 3 h before: the user may be on board already
    expect(query?.get("window")).toBe(String(6 * 3600));
    // A long-distance name only needs long-distance trains, which keeps the board small.
    expect(query?.get("mode")).toBe("HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL");
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

  // One ICE run as two feeds report it. The Dutch feed puts it between
  // Siegburg and Frankfurt Airport, +53. The German feed has its stops from
  // Arnhem to Düsseldorf cancelled (a diversion), so its current segment runs
  // straight from Utrecht to Köln, scheduled at two hours, now +164.
  const segment = (o: {
    tripId: string; from: [string, number, number]; to: [string, number, number];
    scheduledDeparture: string; departure: string; scheduledArrival: string; arrival: string;
  }) => ({
    ...structuredClone(mapFixture[2]),
    trips: [{ tripId: o.tripId, displayName: "ICE 129" }],
    mode: "HIGHSPEED_RAIL",
    realTime: true,
    from: { name: o.from[0], lat: o.from[1], lon: o.from[2] },
    to: { name: o.to[0], lat: o.to[1], lon: o.to[2] },
    scheduledDeparture: o.scheduledDeparture, departure: o.departure,
    scheduledArrival: o.scheduledArrival, arrival: o.arrival,
  });
  const dutchFeed = segment({
    tripId: "20261117_16:38_nl-OpenOV_394269312",
    from: ["Siegburg/Bonn", 50.79, 7.2], to: ["Frankfurt Flughafen Fernb", 50.05, 8.57],
    scheduledDeparture: "2026-11-17T18:36:00Z", departure: "2026-11-17T19:29:00Z",
    scheduledArrival: "2026-11-17T19:13:00Z", arrival: "2026-11-17T20:06:00Z",
  });
  const germanFeedDiverted = segment({
    tripId: "20261117_16:38_de-DELFI_3485829888",
    from: ["Utrecht Centraal", 52.09, 5.11], to: ["Köln Hbf", 50.94, 6.96],
    scheduledDeparture: "2026-11-17T16:04:00Z", departure: "2026-11-17T16:10:00Z",
    scheduledArrival: "2026-11-17T18:11:00Z", arrival: "2026-11-17T20:55:00Z",
  });

  it("keeps one entry per run when two feeds place the same train on different segments", async () => {
    mswServer.use(
      http.get(`${BASE}/api/v5/map/trips`, () => HttpResponse.json([germanFeedDiverted, dutchFeed])),
    );
    const trains = await new TransitousClient().getTrainsInArea(box);
    expect(trains).toHaveLength(1);
    // The German source comes first; the disagreement is flagged.
    expect(trains[0]).toMatchObject({ fromStation: "Utrecht Centraal", delayMinutes: 164, likelyStuck: false, feedsDisagree: true });
  });

  it("does not merge two trains of one line from the same feed that started at the same time", async () => {
    const a = { ...dutchFeed, trips: [{ tripId: "20261117_16:38_de-DELFI_1", displayName: "S12" }] };
    const b = { ...germanFeedDiverted, trips: [{ tripId: "20261117_16:38_de-DELFI_2", displayName: "S12" }] };
    mswServer.use(http.get(`${BASE}/api/v5/map/trips`, () => HttpResponse.json([a, b])));
    expect(await new TransitousClient().getTrainsInArea(box)).toHaveLength(2);
  });

  it("merges one train listed twice by the same feed on the same segment and times", async () => {
    // "91N", listed twice in the German feed on 17 Nov 2026.
    const twice = [1, 2].map((n) => ({ ...germanFeedDiverted, trips: [{ tripId: `20261117_18:01_de-DELFI_${n}`, displayName: "91N" }] }));
    mswServer.use(http.get(`${BASE}/api/v5/map/trips`, () => HttpResponse.json(twice)));
    const trains = await new TransitousClient().getTrainsInArea(box);
    expect(trains).toHaveLength(1);
    expect(trains[0].feedsDisagree).toBeUndefined();
  });

  it("does not call a train stuck on a segment that skips cancelled stops", async () => {
    mswServer.use(http.get(`${BASE}/api/v5/map/trips`, () => HttpResponse.json([germanFeedDiverted])));
    const [train] = await new TransitousClient().getTrainsInArea(box);
    expect(train).toMatchObject({ delayMinutes: 164, likelyStuck: false });
  });
});

describe("TransitousClient.countryAt", () => {
  it("returns the country code of the nearest stop and asks only once per place", async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${BASE}/api/v1/reverse-geocode`, ({ request }) => {
        calls++;
        expect(new URL(request.url).searchParams.get("place")).toBe("52.0894,5.1101");
        return HttpResponse.json([{ name: "Utrecht Centraal", country: "NL", type: "STOP" }]);
      }),
    );
    const client = new TransitousClient();
    expect(await client.countryAt(52.0894, 5.1101)).toBe("NL");
    expect(await client.countryAt(52.0894, 5.1101)).toBe("NL");
    expect(calls).toBe(1);
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
