import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../setup.js";
import {
  currentNotices,
  DbTimetablesClient,
  isoToDbTime,
  nameVariants,
  parseBoard,
} from "../../src/clients/db-timetables.js";
import { ProviderError } from "../../src/errors.js";

const BASE = "https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1";
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const xml = (body: string) => new HttpResponse(body, { headers: { "Content-Type": "application/xml" } });
const client = () => new DbTimetablesClient({ clientId: "id", apiKey: "key" });

function useHamm() {
  const seen: string[] = [];
  mswServer.use(
    http.get(`${BASE}/station/:name`, ({ params, request }) => {
      seen.push(`station ${params.name}`);
      expect(request.headers.get("DB-Client-Id")).toBe("id");
      expect(request.headers.get("DB-Api-Key")).toBe("key");
      // DB only finds the exact spelling.
      return xml(params.name === "Hamm(Westf)Hbf" ? fixture("db-station.xml") : "<stations></stations>");
    }),
    http.get(`${BASE}/fchg/8000149`, () => { seen.push("fchg"); return xml(fixture("db-fchg.xml")); }),
    http.get(`${BASE}/plan/8000149/:day/:hour`, ({ params }) => {
      seen.push(`plan ${params.day}/${params.hour}`);
      return xml(fixture("db-plan.xml"));
    }),
  );
  return seen;
}

describe("time and name helpers", () => {
  it("converts an instant to DB's German local time format", () => {
    expect(isoToDbTime("2026-11-15T21:37:00Z")).toBe("2611152237"); // winter, UTC+1
    expect(isoToDbTime("2026-07-01T10:05:00Z")).toBe("2607011205"); // summer, UTC+2
  });

  it("produces DB's spelling for names with brackets and 'Hauptbahnhof'", () => {
    expect(nameVariants("Hamm (Westf), Hauptbahnhof")).toContain("Hamm(Westf)Hbf");
    expect(nameVariants("Frankfurt (Main) Hauptbahnhof")).toContain("Frankfurt(Main)Hbf");
    expect(nameVariants("Köln Messe/Deutz Bf")).toContain("Köln Messe/Deutz");
    expect(nameVariants("Köln Hbf")[0]).toBe("Köln Hbf");
  });
});

describe("parseBoard and currentNotices", () => {
  it("reads train numbers from the timetable feed and messages from the changes feed", () => {
    const plan = parseBoard(fixture("db-plan.xml"));
    expect(plan.map((s) => s.number)).toEqual(["89739", "26837", "90041"]);
    expect(plan[2].plannedTimes).toEqual(["2611152237", "2611152309"]);
    const changes = parseBoard(fixture("db-fchg.xml"));
    expect(changes[2].messages.map((m) => [m.type, m.code ?? m.category])).toEqual([
      ["h", "BAUARBEITEN"], ["d", 32], ["d", 48], ["d", 32], ["d", 48],
    ]);
    expect(changes[0].messages).toEqual([]);
  });

  it("lists delay reasons once each, latest first", () => {
    const notices = currentNotices([
      { type: "d", code: 32, ts: "2611152130" },
      { type: "d", code: 48, ts: "2611152238" },
      { type: "d", code: 32, ts: "2611152130" },
    ]);
    expect(notices.map((n) => n.text)).toEqual(["Delay from its previous journey", "Longer stop at a station"]);
    expect(notices[0]).toMatchObject({ kind: "delay-reason", code: 48, since: "2026-11-15T21:38:00.000Z" });
  });

  it("drops quality notices that a later 'no quality problems' cancels", () => {
    const notices = currentNotices([
      { type: "q", code: 90, ts: "2611151000" },
      { type: "q", code: 82, ts: "2611151001" },
      { type: "q", code: 88, ts: "2611151100" },
      { type: "q", code: 97, ts: "2611151200" },
    ]);
    expect(notices.map((n) => [n.kind, n.text])).toEqual([["quality", "Train very busy"]]);
  });

  it("keeps current quality notices, names disruptions, and ignores unknown codes", () => {
    const notices = currentNotices([
      { type: "q", code: 90, ts: "2611151000" },
      { type: "f", code: 0, ts: "2611151000" },
      { type: "h", category: "BAUARBEITEN", ts: "2611150230" },
      { type: "h", category: "BAUARBEITEN", ts: "2611150330" },
    ]);
    expect(notices.map((n) => [n.kind, n.text])).toEqual([
      ["quality", "No food or drink available"],
      ["disruption", "Construction work"],
    ]);
  });
});

describe("DbTimetablesClient.getNoticesForTrain", () => {
  it("finds the station by DB's spelling and matches the train by number and planned time", async () => {
    const seen = useHamm();
    const result = await client().getNoticesForTrain("Hamm (Westf), Hauptbahnhof", "90041", "2026-11-15T21:37:00Z");
    expect(result).toEqual({
      station: "Hamm (Westf), Hauptbahnhof",
      notices: [
        { kind: "delay-reason", text: "Delay from its previous journey", code: 48, since: "2026-11-15T21:38:00.000Z" },
        { kind: "delay-reason", text: "Longer stop at a station", code: 32, since: "2026-11-15T20:30:00.000Z" },
        { kind: "disruption", text: "Construction work", since: "2026-11-15T01:30:00.000Z" },
      ],
    });
    expect(seen).toContain("station Hamm(Westf)Hbf");
    expect(seen).toContain("plan 261115/22");
  });

  it("returns an empty list for a train with no notices or not in the data", async () => {
    useHamm();
    const db = client();
    const re1 = await db.getNoticesForTrain("Hamm (Westf), Hauptbahnhof", "26837", "2026-11-15T22:40:00Z");
    expect(re1?.notices.map((n) => n.text)).toEqual(["Delay of a train running ahead"]);
    const re6 = await db.getNoticesForTrain("Hamm (Westf), Hauptbahnhof", "89739", "2026-11-15T22:15:00Z");
    expect(re6?.notices).toEqual([]);
    const unknown = await db.getNoticesForTrain("Hamm (Westf), Hauptbahnhof", "12345", "2026-11-15T22:15:00Z");
    expect(unknown?.notices).toEqual([]);
  });

  it("returns null when the station has no confident match", async () => {
    useHamm();
    expect(await client().getNoticesForTrain("Nowhere Hbf", "1", "2026-11-15T22:15:00Z")).toBeNull();
  });

  it("treats a 404 from the station lookup as no match", async () => {
    mswServer.use(http.get(`${BASE}/station/:name`, () => new HttpResponse("", { status: 404 })));
    expect(await client().findStationEva("Köln Breslauer Platz/Hbf")).toBeNull();
  });

  it("caches station lookups and the changes feed between calls", async () => {
    const seen = useHamm();
    const db = client();
    await db.getNoticesForTrain("Hamm (Westf), Hauptbahnhof", "90041", "2026-11-15T21:37:00Z");
    await db.getNoticesForTrain("Hamm (Westf), Hauptbahnhof", "26837", "2026-11-15T22:40:00Z");
    expect(seen.filter((s) => s === "fchg")).toHaveLength(1);
    expect(seen.filter((s) => s.startsWith("station")).length).toBeLessThanOrEqual(3);
  });

  it("explains a missing subscription and a rejected key", async () => {
    mswServer.use(
      http.get(`${BASE}/station/:name`, () =>
        new HttpResponse("<errorResponse><moreInformation>Not registered to plan</moreInformation></errorResponse>", { status: 403 })),
    );
    await expect(client().findStationEva("Köln Hbf")).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.source === "db" && /not subscribed/.test(e.message),
    );
    mswServer.use(http.get(`${BASE}/station/:name`, () => new HttpResponse("", { status: 401 })));
    await expect(client().findStationEva("Köln Hbf")).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && /rejected the key/.test(e.message),
    );
  });
});
