import { http, HttpResponse } from "msw";
import * as devalue from "devalue";
import { describe, expect, it } from "vitest";
import { mswServer } from "../setup.js";
import { MarudorClient } from "../../src/clients/marudor.js";
import { ProviderError } from "../../src/errors.js";
import stationSearchFixture from "../fixtures/station-search.json" assert { type: "json" };
import journeyFindFixture from "../fixtures/journey-find.json" assert { type: "json" };
import trainDetailsFixture from "../fixtures/train-details.json" assert { type: "json" };
import connectionsFixture from "../fixtures/connections.json" assert { type: "json" };
import bahnRoutingFixture from "../fixtures/bahn-routing.json" assert { type: "json" };
import disruptionsFixture from "../fixtures/disruptions.json" assert { type: "json" };

const BASE_URL = "https://bahn.expert";

function makeRpcResponse(data: unknown): string {
  const encoded = devalue.stringify(data);
  return JSON.stringify({ result: { data: encoded } });
}

// ---------------------------------------------------------------------------
// Existing tests
// ---------------------------------------------------------------------------

describe("MarudorClient.searchStations", () => {
  it("happy path: returns stations from fixture data", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/stopPlace.byTerm`, ({ request }) => {
        // Verify the encoding pipeline: ?input=<URL-encoded JSON string of devalue output>
        const rawInput = new URL(request.url).searchParams.get("input");
        expect(rawInput).not.toBeNull();
        const innerJsonString = JSON.parse(rawInput!);
        const decoded = devalue.parse(innerJsonString);
        expect(decoded).toEqual({ searchTerm: "Köln Hbf" });
        return new HttpResponse(makeRpcResponse(stationSearchFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
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

  it("failure path: throws ProviderError with kind=http on 503", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/stopPlace.byTerm`, () => {
        return new HttpResponse("Service Unavailable", { status: 503 });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    await expect(client.searchStations("Köln Hbf")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.kind === "http" &&
        err.source === "marudor",
    );
  });
});

// ---------------------------------------------------------------------------
// findJourney
// ---------------------------------------------------------------------------

describe("MarudorClient.findJourney", () => {
  it("happy path: returns TrainIdentifier[] mapped from fixture", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/journey.find`, ({ request }) => {
        const rawInput = new URL(request.url).searchParams.get("input");
        expect(rawInput).not.toBeNull();
        const innerJsonString = JSON.parse(rawInput!);
        const decoded = devalue.parse(innerJsonString) as {
          journeyNumber: number;
          category?: string;
          date: Date;
        };
        expect(decoded.journeyNumber).toBe(597);
        expect(decoded.category).toBe("ICE");
        expect(decoded.date).toBeInstanceOf(Date);
        return new HttpResponse(makeRpcResponse(journeyFindFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    const result = await client.findJourney("ICE 597", "2026-05-18");

    expect(result).toHaveLength(1);
    expect(result[0].journeyId).toBe(
      "20260518-589dd5e9-6c97-3e24-9eb8-9d9f8871de73",
    );
    expect(result[0].name).toBe("ICE 597");
    expect(result[0].origin).toBe("Berlin Hbf");
    expect(result[0].destination).toBe("München Hbf");
    expect(result[0].date).toBe("2026-05-18");
  });

  it("accepts bare number without category prefix", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/journey.find`, ({ request }) => {
        const rawInput = new URL(request.url).searchParams.get("input");
        const innerJsonString = JSON.parse(rawInput!);
        const decoded = devalue.parse(innerJsonString) as {
          journeyNumber: number;
          category?: string;
        };
        expect(decoded.journeyNumber).toBe(691);
        expect(decoded.category).toBeUndefined();
        return new HttpResponse(makeRpcResponse(journeyFindFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    const result = await client.findJourney("691", "2026-05-18");
    expect(result.length).toBeGreaterThan(0);
  });

  it("throws ProviderError with kind=not_found when API returns empty array", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/journey.find`, () => {
        return new HttpResponse(makeRpcResponse([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    await expect(
      client.findJourney("ICE 9999", "2026-05-18"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.kind === "not_found" &&
        err.source === "marudor",
    );
  });

  it("filters out results whose category doesn't match the requested one", async () => {
    // Marudor's category param isn't strictly enforced server-side: asking
    // for "RB 597" can return ICE 597 results. We filter client-side so the
    // user gets nothing rather than the wrong train.
    mswServer.use(
      http.get(`${BASE_URL}/rpc/journey.find`, () => {
        return new HttpResponse(makeRpcResponse(journeyFindFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    // The fixture only contains ICE entries; asking for an RB should be filtered out.
    await expect(
      client.findJourney("RB 597", "2026-05-18"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.kind === "not_found" &&
        err.source === "marudor",
    );
  });
});

// ---------------------------------------------------------------------------
// getJourneyDetails
// ---------------------------------------------------------------------------

describe("MarudorClient.getJourneyDetails", () => {
  it("happy path: maps stops correctly from train-details fixture", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/journey.detailsByJourneyId`, ({ request }) => {
        const rawInput = new URL(request.url).searchParams.get("input");
        expect(rawInput).not.toBeNull();
        const innerJsonString = JSON.parse(rawInput!);
        const decoded = devalue.parse(innerJsonString) as string;
        expect(decoded).toBe("20260518-589dd5e9-6c97-3e24-9eb8-9d9f8871de73");
        return new HttpResponse(makeRpcResponse(trainDetailsFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    const status = await client.getJourneyDetails(
      "20260518-589dd5e9-6c97-3e24-9eb8-9d9f8871de73",
    );

    expect(status.identifier.journeyId).toBe(
      "20260518-589dd5e9-6c97-3e24-9eb8-9d9f8871de73",
    );
    expect(status.identifier.name).toBe("ICE 597");
    expect(status.identifier.destination).toBe("München Hbf");
    expect(status.cancelled).toBe(false);

    // 5 stops in the fixture
    expect(status.stopovers).toHaveLength(5);

    // Origin stop (Berlin Hbf) — no arrival, has departure
    const berlinHbf = status.stopovers[0];
    expect(berlinHbf.evaNumber).toBe("8098160");
    expect(berlinHbf.stationName).toBe("Berlin Hbf");
    expect(berlinHbf.scheduledArrival).toBeUndefined();
    expect(berlinHbf.scheduledDeparture).toBe("2026-05-18T07:27:00.000Z");
    expect(berlinHbf.departureDelayMinutes).toBe(0);
    expect(berlinHbf.outgoingConnections).toEqual([]);

    // Berlin Südkreuz — has arrival and departure, arrival delay = -2
    const suedkreuz = status.stopovers[1];
    expect(suedkreuz.evaNumber).toBe("8011113");
    expect(suedkreuz.arrivalDelayMinutes).toBe(-2);
    expect(suedkreuz.scheduledArrival).toBe("2026-05-18T07:33:00.000Z");
    expect(suedkreuz.predictedArrival).toBe("2026-05-18T07:31:14.000Z");
    expect(suedkreuz.cancelled).toBe(false);

    // Leipzig Hbf — arrival delay 3
    const leipzig = status.stopovers[3];
    expect(leipzig.evaNumber).toBe("8010205");
    expect(leipzig.arrivalDelayMinutes).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getConnections
// ---------------------------------------------------------------------------

describe("MarudorClient.getConnections", () => {
  it("happy path: maps OutgoingConnection[] from fixture", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/connections.connections`, ({ request }) => {
        const rawInput = new URL(request.url).searchParams.get("input");
        const innerJsonString = JSON.parse(rawInput!);
        const decoded = devalue.parse(innerJsonString) as {
          journeyId: string;
          arrivalId: string;
          evaNumber: string;
        };
        expect(decoded.journeyId).toBe(
          "20260518-589dd5e9-6c97-3e24-9eb8-9d9f8871de73",
        );
        expect(decoded.arrivalId).toBe("8010101_A_1");
        expect(decoded.evaNumber).toBe("8010101");
        return new HttpResponse(makeRpcResponse(connectionsFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    const conns = await client.getConnections(
      "20260518-589dd5e9-6c97-3e24-9eb8-9d9f8871de73",
      "8010101_A_1",
      "8010101",
    );

    expect(conns).toHaveLength(2);

    // First connection: ICE 1587 to München Hbf
    // Has one CRITICAL persona → willBeHeld = true
    const ice = conns[0];
    expect(ice.trainName).toBe("ICE 1587");
    expect(ice.destination).toBe("München Hbf");
    expect(ice.willBeHeld).toBe(true);
    expect(ice.scheduledDeparture).toBe("2026-05-18T09:34:00+00:00");
    expect(ice.predictedDeparture).toBe("2026-05-18T09:35:00+00:00");
    expect(ice.delayMinutes).toBe(1);

    // Second connection: STR 6 to Rieth, Erfurt — all IMPOSSIBLE, no willBeHeld
    const tram = conns[1];
    expect(tram.trainName).toBe("STR STR 6");
    expect(tram.destination).toBe("Rieth, Erfurt");
    expect(tram.willBeHeld).toBeUndefined();
  });

  it("willBeHeld: not set when no persona has CRITICAL status", async () => {
    const noHoldFixture = {
      ...connectionsFixture,
      connections: [
        {
          ...connectionsFixture.connections[1], // the STR one — all IMPOSSIBLE
        },
      ],
    };

    mswServer.use(
      http.get(`${BASE_URL}/rpc/connections.connections`, () => {
        return new HttpResponse(makeRpcResponse(noHoldFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    const conns = await client.getConnections("jid", "arrId", "8010101");
    expect(conns[0].willBeHeld).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getTrainStatus — orchestrator
// ---------------------------------------------------------------------------

describe("MarudorClient.getTrainStatus", () => {
  const JOURNEY_ID = "20260518-589dd5e9-6c97-3e24-9eb8-9d9f8871de73";

  function setupOrchestatorHandlers(options: {
    failConnectionForEva?: string;
  } = {}) {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/journey.find`, () => {
        return new HttpResponse(makeRpcResponse(journeyFindFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
      http.get(`${BASE_URL}/rpc/journey.detailsByJourneyId`, () => {
        return new HttpResponse(makeRpcResponse(trainDetailsFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
      http.get(`${BASE_URL}/rpc/connections.connections`, ({ request }) => {
        const rawInput = new URL(request.url).searchParams.get("input");
        const innerJsonString = JSON.parse(rawInput!);
        const decoded = devalue.parse(innerJsonString) as {
          evaNumber: string;
        };

        if (
          options.failConnectionForEva &&
          decoded.evaNumber === options.failConnectionForEva
        ) {
          return new HttpResponse("Service Unavailable", { status: 503 });
        }

        return new HttpResponse(makeRpcResponse(connectionsFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  }

  it("happy path: orchestrates all three procedures and populates outgoingConnections", async () => {
    setupOrchestatorHandlers();

    const client = new MarudorClient({ baseUrl: BASE_URL });
    const status = await client.getTrainStatus("ICE 597", "2026-05-18");

    expect(status.identifier.journeyId).toBe(JOURNEY_ID);
    expect(status.identifier.name).toBe("ICE 597");
    expect(status.stopovers).toHaveLength(5);

    // Origin stop (Berlin Hbf) has no arrivalId → outgoingConnections = []
    const origin = status.stopovers[0];
    expect(origin.evaNumber).toBe("8098160");
    expect(origin.outgoingConnections).toEqual([]);

    // Non-origin stops that have an arrivalId should have connections populated
    // Berlin Südkreuz (stop[1]) has arrival.id = "8011113_A_1"
    const suedkreuz = status.stopovers[1];
    expect(suedkreuz.outgoingConnections.length).toBeGreaterThan(0);
    // The ICE connection has willBeHeld: true (CRITICAL persona in fixture)
    const held = suedkreuz.outgoingConnections.find((c) => c.willBeHeld);
    expect(held).toBeDefined();
  });

  it("partial failure: one stop's connections call returns 503 → that stop gets [] but others are populated", async () => {
    // Fail the Erfurt Hbf stop (evaNumber "8010101")
    setupOrchestatorHandlers({ failConnectionForEva: "8010101" });

    const client = new MarudorClient({ baseUrl: BASE_URL });
    const status = await client.getTrainStatus("ICE 597", "2026-05-18");

    expect(status.stopovers).toHaveLength(5);

    // All stopovers present despite partial failure
    const erfurt = status.stopovers.find((s) => s.evaNumber === "8010101");
    expect(erfurt).toBeDefined();
    expect(erfurt!.outgoingConnections).toEqual([]);

    // Other stops with arrivalIds still have connections
    const suedkreuz = status.stopovers.find((s) => s.evaNumber === "8011113");
    expect(suedkreuz!.outgoingConnections.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// searchJourneys
// ---------------------------------------------------------------------------

describe("MarudorClient.searchJourneys", () => {
  it("happy path: returns JourneyOption[] with legs mapped from bahn.routing fixture", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/bahn.routing`, ({ request }) => {
        const rawInput = new URL(request.url).searchParams.get("input");
        expect(rawInput).not.toBeNull();
        const innerJsonString = JSON.parse(rawInput!);
        const decoded = devalue.parse(innerJsonString) as {
          start: { type: string; evaNumber: string };
          destination: { type: string; evaNumber: string };
          searchForDeparture: boolean;
          time: Date;
          klasse: string;
        };
        expect(decoded.start.evaNumber).toBe("8098160");
        expect(decoded.destination.evaNumber).toBe("8000261");
        expect(decoded.searchForDeparture).toBe(true);
        expect(decoded.klasse).toBe("KLASSE_2");
        expect(decoded.time).toBeInstanceOf(Date);
        return new HttpResponse(makeRpcResponse(bahnRoutingFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    const options = await client.searchJourneys("8098160", "8000261");

    expect(options.length).toBeGreaterThan(0);

    // First option has at least one leg
    const option = options[0];
    expect(option.legs.length).toBeGreaterThan(0);

    // First leg has required fields
    const leg = option.legs[0];
    expect(leg.trainName).toBe("ICE 597");
    expect(leg.from.evaNumber).toBe("8098160");
    expect(leg.from.name).toBe("Berlin Hbf");
    expect(leg.to.evaNumber).toBe("8011113");
    expect(leg.to.name).toBe("Berlin Südkreuz");
    expect(leg.scheduledDeparture).toBe("2026-05-18T07:27:00.000Z");
    expect(leg.predictedDeparture).toBe("2026-05-18T07:27:33.000Z");
    expect(leg.scheduledArrival).toBe("2026-05-18T07:33:00.000Z");
    expect(leg.predictedArrival).toBe("2026-05-18T07:31:14.000Z");
    expect(leg.departureDelayMinutes).toBe(0);
    expect(leg.arrivalDelayMinutes).toBe(-2);

    // riskyTransfers starts empty (Task 16 fills it in)
    expect(option.riskyTransfers).toEqual([]);
  });

  it("upstream 500: bubbles ProviderError with kind=http", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/bahn.routing`, () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    await expect(
      client.searchJourneys("8098160", "8000261"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderError &&
        err.kind === "http" &&
        err.source === "marudor",
    );
  });
});

// ---------------------------------------------------------------------------
// getDisruptions
// ---------------------------------------------------------------------------

describe("MarudorClient.getDisruptions", () => {
  it("happy path: returns Disruption[] with HIM messages, deduped by id", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/iris.departures`, ({ request }) => {
        const rawInput = new URL(request.url).searchParams.get("input");
        expect(rawInput).not.toBeNull();
        const innerJsonString = JSON.parse(rawInput!);
        const decoded = devalue.parse(innerJsonString) as {
          evaNumber: string;
        };
        expect(decoded.evaNumber).toBe("8000207");
        return new HttpResponse(makeRpcResponse(disruptionsFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = new MarudorClient({ baseUrl: BASE_URL });
    const disruptions = await client.getDisruptions({ evaNumber: "8000207" });

    // Two departures both have HIM-001 → should be deduped to one Disruption
    expect(disruptions.length).toBe(1);

    const disruption = disruptions[0];
    expect(disruption.id).toBe("HIM-001");
    expect(disruption.headline).toBe("Stellwerksstörung");
    expect(disruption.description).toBe(
      "Beeinträchtigung durch Stellwerksstörung",
    );
    expect(disruption.severity).toBe("high"); // "Stellwerk" → "high"
    expect(disruption.affectedSegments).toEqual([]);
    expect(disruption.startTime).toBe("2026-05-18T16:00:00.000+02:00");
  });

  it("without evaNumber: returns [] without invoking any rpc call", async () => {
    // No MSW handler registered — if a call happens, it will fail
    const client = new MarudorClient({ baseUrl: BASE_URL });
    const disruptions = await client.getDisruptions({});

    expect(disruptions).toEqual([]);
  });
});
