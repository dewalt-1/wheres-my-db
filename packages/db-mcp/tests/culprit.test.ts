import { describe, expect, it } from "vitest";
import type { BoardTrain } from "../src/clients/open-boards.js";
import { findCulprit, orderOf, orderOnBoard, trainsOnStretch } from "../src/culprit.js";
import type { Stopover, TrainInArea, TrainStatus } from "../src/types.js";

const stop = (name: string, lat: number, dep?: string): Stopover =>
  ({ stationName: name, stationId: name, lat, lon: 7, cancelled: false, alerts: [], predictedDeparture: dep }) as Stopover;
const status = {
  tripId: "mine", name: "ICE 124", headsign: "", mode: "HIGHSPEED_RAIL", realTime: true, cancelled: false, alerts: [],
  path: Array.from({ length: 101 }, (_, i): [number, number] => [51 + i * 0.01, 7]),
  stopovers: [stop("A", 51), stop("B", 52)],
} as TrainStatus;
const train = (over: Partial<TrainInArea>) =>
  ({ tripId: "o", trainName: "RE19", mode: "REGIONAL_RAIL", fromStation: "X", toStation: "Y", fromLat: 51.3, fromLon: 7, toLat: 51.4, toLon: 7,
    predictedDeparture: "", predictedArrival: "", delayMinutes: 20, lat: 51.35, lon: 7, progress: 0.5, delayGainedOnSegmentMinutes: 0, likelyStuck: false, realTime: true, ...over }) as TrainInArea;

describe("trainsOnStretch", () => {
  const found = (over: Partial<TrainInArea>) => trainsOnStretch(status, 0, 1, [train(over)]).length;
  it("keeps trains running the same way on the route line", () => expect(found({})).toBe(1));
  it("ignores the opposite direction", () => expect(found({ fromLat: 51.4, toLat: 51.3 })).toBe(0));
  it("ignores trains on another line", () => expect(found({ fromLon: 7.1, toLon: 7.1 })).toBe(0));
  it("ignores trams and other records of the same train", () => {
    expect(found({ mode: "TRAM" })).toBe(0);
    expect(found({ tripId: "mine" })).toBe(0);
    expect(found({ trainName: "ICE 124" })).toBe(0);
  });
  it("keeps other runs of the user's own line", () => {
    expect(trainsOnStretch({ ...status, name: "RE19" }, 0, 1, [train({})])).toHaveLength(1);
  });
});

describe("orderOf", () => {
  const mine = stop("A", 51, "2026-11-23T15:55:00Z");
  const other = (dep: string, realTime = true) => ({ ...status, realTime, stopovers: [stop("A", 51.001, dep)] });
  it("compares departures at the user's last stop", () => {
    expect(orderOf(mine, other("2026-11-23T15:10:00Z"))).toBe("ahead");
    expect(orderOf(mine, other("2026-11-23T16:10:00Z"))).toBe("behind");
  });
  it("treats departures within 10 minutes as unknown: passed stops often still carry timetable times", () => {
    // RE19 20026 showed 15:50 at Oberhausen; DB recorded it leaving at 16:00, after ICE 124.
    expect(orderOf(mine, other("2026-11-23T15:50:00Z"))).toBe("unknown");
  });
  it("trusts DB's recorded times over that", () => {
    const board = [
      { number: "124", time: "2026-11-23T15:55:59+01:00" }, { number: "20026", time: "2026-11-23T16:00:10+01:00" },
    ] as BoardTrain[];
    expect(orderOnBoard(board, "124", "20026")).toBe("behind");
    expect(orderOnBoard(board, "20026", "124")).toBe("ahead");
    expect(orderOnBoard(board, "124", "1")).toBeUndefined();
  });
  it("does not guess without live data or a shared stop", () => {
    expect(orderOf(mine, other("2026-11-23T15:10:00Z", false))).toBe("unknown");
    expect(orderOf(mine, { ...status, stopovers: [stop("Z", 50)] })).toBe("unknown");
    expect(orderOf(mine, undefined)).toBe("unknown");
  });
});

describe("findCulprit", () => {
  const find = (t: Partial<TrainInArea>, order: "ahead" | "behind" | "unknown") =>
    findCulprit({ delayMinutes: 45, mode: "HIGHSPEED_RAIL", suspects: [{ train: train(t), number: "20024", order }], boards: [], ownReasons: [] });
  it("does not accuse a train that is only late when its place in the queue is unknown", () => {
    expect(find({}, "unknown").status).toBe("none-found");
  });
  it("calls a late train ahead possible, never likely, without a reported fault", () => {
    expect(find({}, "ahead").candidates).toMatchObject([{ confidence: "possible" }]);
  });
  describe("with a fault reported on the train ahead", () => {
    const fault = (over: { mode?: string; ownReasons?: string[] } = {}) =>
      findCulprit({
        delayMinutes: 45, mode: "HIGHSPEED_RAIL", suspects: [{ train: train({ mode: over.mode ?? "REGIONAL_RAIL" }), number: "20024", order: "ahead" }],
        boards: [{ station: "A", trains: [{ journeyId: "j", name: "RE19", number: "20024", scheduled: "", time: "", cancelled: false, causes: [36], quality: [], disruptions: [] }] }],
        ownReasons: over.ownReasons ?? [],
      }).candidates?.[0];
    it("is likely when DB blames another train, or gives no reason", () => {
      expect(fault()?.confidence).toBe("likely");
      expect(fault({ ownReasons: ["Technical fault on another train"] })?.confidence).toBe("likely");
    });
    it("is only possible when DB gives a reason that is not another train", () => {
      expect(fault({ ownReasons: ["Emergency doctor on the line"] })).toMatchObject({ confidence: "possible" });
    });
    it("is only possible when one is an S-Bahn and the other is not", () => {
      expect(fault({ mode: "SUBURBAN" })).toMatchObject({ confidence: "possible", evidence: expect.arrayContaining(["may use separate tracks"]) });
    });
  });
  it("does not suspect an S-Bahn of holding up a mainline train just for being late", () => {
    expect(find({ mode: "SUBURBAN" }, "ahead").status).toBe("none-found");
  });
  it("ignores a train ahead that is on time, and one without live data", () => {
    expect(find({ delayMinutes: 2 }, "ahead").status).toBe("none-found");
    expect(find({ realTime: false }, "ahead").status).toBe("none-found");
  });
});
