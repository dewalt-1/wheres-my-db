import { http, HttpResponse } from "msw";
import * as devalue from "devalue";
import { describe, expect, it } from "vitest";
import { mswServer } from "../setup.js";
import { MarudorClient } from "../../src/clients/marudor.js";
import { ProviderError } from "../../src/errors.js";
import fixture from "../fixtures/station-search.json" assert { type: "json" };

const BASE_URL = "https://bahn.expert";

function makeRpcResponse(data: unknown): string {
  const encoded = devalue.stringify(data);
  return JSON.stringify({ result: { data: encoded } });
}

describe("MarudorClient.searchStations", () => {
  it("happy path: returns stations from fixture data", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/rpc/stopPlace.byTerm`, () => {
        return new HttpResponse(makeRpcResponse(fixture), {
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
