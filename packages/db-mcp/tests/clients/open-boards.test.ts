import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../setup.js";
import { dhidOf, noticesOf, OpenBoardsClient, parseOpenBoard } from "../../src/clients/open-boards.js";

const URL_ = "https://apis.deutschebahn.com/db-api-marketplace/apis/open-boards/v1/departures";
const client = () => new OpenBoardsClient({ clientId: "id", apiKey: "key" });
// Shapes copied from DB's answer for Köln Hbf on 23 Nov 2026.
const board = {
  departures: [
    { journeyId: "j1", time: "2026-11-23T14:56:05+01:00", timeSchedule: "2026-11-23T14:49:00+01:00", messages: [3, 40, 44, 30],
      journeyInfo: { headerJourneyNumber: 124 }, transport: { journeyDescription: "ICE 124", journeyNumber: 124 } },
    { journeyId: "j2", time: "2026-11-23T15:00:00+01:00", timeSchedule: "2026-11-23T15:00:00+01:00", cancelled: true, messages: [],
      transport: { journeyDescription: "S11", journeyNumber: 32181 } },
  ],
  messages: {
    attributes: [{ messageID: 30, code: "CK", descriptions: [{ language: "deu", text: "Komfort Check-in" }] }],
    disruptions: [{ messageID: 3, disruptionID: "d", cause: "TECHNICAL_PROBLEM_RAILWAY_SECTION", descriptions: [
      { language: "deu", text: "Eine Reparatur an einer Weiche" }, { language: "eng", text: "Repair work on a set of switches" }] }],
    risCauseCodes: [{ messageID: 40, code: "45", descriptions: [{ language: "deu", text: "Vorfahrt eines anderen Zuges" }] }],
    risQualityDeviations: [{ messageID: 44, code: "82", descriptions: [{ language: "deu", text: "Mehrere Wagen fehlen" }] }],
  },
};

describe("OpenBoards", () => {
  it("reads DB's stop code out of Transitous stop ids", () => {
    expect(dhidOf("de-DELFI_de:05119:14022:90:9")).toBe("de:05119:14022");
    expect(dhidOf("at-Railway-Current-Reference-Data-2026_de:05315:11201:7:72")).toBe("de:05315:11201");
    expect(dhidOf("de-DELFI_nl:4:18038")).toBeUndefined();
    expect(dhidOf("nl-OpenOV_2861315")).toBeUndefined();
  });

  it("gives a train's delay reason, quality notice and disruption text in English", () => {
    const [ice, s11] = parseOpenBoard(board);
    expect(noticesOf(ice)).toEqual([
      { kind: "delay-reason", text: "Another train given priority", code: 45 },
      { kind: "quality", text: "Several coaches missing", code: 82 },
      { kind: "disruption", text: "Repair work on a set of switches" },
    ]);
    expect(s11).toMatchObject({ cancelled: true, causes: [] });
  });

  it("finds a late train by looking around both its scheduled and expected time", async () => {
    let body: { stopPlaceOrStation?: unknown; timeWindow?: { timeStart: string; timeEnd: string } } = {};
    mswServer.use(http.post(URL_, async ({ request }) => { body = (await request.json()) as typeof body; return HttpResponse.json(board); }));
    const res = await client().getNoticesForTrain({ stationName: "Köln Hbf", stationId: "de-DELFI_de:05315:11201" }, "124", "2026-11-23T13:49:00Z", "2026-11-23T15:20:00Z");
    expect(res?.notices).toHaveLength(3);
    expect(body.stopPlaceOrStation).toEqual({ dhids: ["de:05315:11201"] });
    expect(Date.parse(body.timeWindow!.timeStart)).toBeLessThanOrEqual(Date.parse("2026-11-23T13:39:00Z"));
    expect(Date.parse(body.timeWindow!.timeEnd)).toBeGreaterThanOrEqual(Date.parse("2026-11-23T15:30:00Z"));
  });

  it("returns null abroad without asking, and an empty board as no notices", async () => {
    expect(await client().getNoticesForTrain({ stationName: "Arnhem", stationId: "de-DELFI_nl:4:18038" }, "124", "2026-11-23T15:28:00Z")).toBeNull();
    mswServer.use(http.post(URL_, () => HttpResponse.json({ messages: {}, meta: {} })));
    expect((await client().getNoticesForTrain({ stationName: "E", stationId: "x_de:05154:36119" }, "124", "2026-11-23T15:28:00Z"))?.notices).toEqual([]);
  });

  it("explains a missing subscription and a rejected key", async () => {
    const reply = (moreInformation: string) => mswServer.use(http.post(URL_, () => HttpResponse.json({ moreInformation }, { status: 401 })));
    reply("Cannot find valid subscription for the incoming API request.");
    await expect(client().getBoard("de:1", 0, 1)).rejects.toThrow(/not subscribed to OpenBoards/);
    reply("Invalid client id or secret.");
    await expect(client().getBoard("de:1", 0, 1)).rejects.toThrow(/rejected the key/);
  });
});
