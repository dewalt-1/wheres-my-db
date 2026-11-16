import { describe, expect, it } from "vitest";
import { analyseLineAhead, boxAround, describeLineAhead, stretchAhead } from "../src/line-ahead.js";
import type { Stopover, TrainInArea, TrainStatus } from "../src/types.js";

const T0 = Date.parse("2026-11-16T18:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

// A straight line north: A → B → C → D, 11 km apart. Your train left A two
// minutes ago and is officially 5 minutes late at D.
function stop(name: string, lat: number, arr?: number, dep?: number, delay = 5): Stopover {
  return {
    stationName: name, stationId: name, lat, lon: 7, cancelled: false, alerts: [],
    predictedArrival: arr === undefined ? undefined : at(arr),
    predictedDeparture: dep === undefined ? undefined : at(dep),
    arrivalDelayMinutes: arr === undefined ? undefined : delay,
  };
}
const yours: TrainStatus = {
  tripId: "yours", name: "RE 1", headsign: "D", mode: "REGIONAL_RAIL", realTime: true, cancelled: false, alerts: [],
  stopovers: [stop("A", 50.0, undefined, -2), stop("B", 50.1, 8, 9), stop("C", 50.2, 18, 19), stop("D", 50.3, 28)],
};

/** A train on the stretch from one stop to the next. */
function other(over: Partial<TrainInArea> & { from: [string, number]; to: [string, number] }): TrainInArea {
  const { from, to, ...rest } = over;
  return {
    tripId: "other", trainName: "RE 5", mode: "REGIONAL_RAIL",
    fromStation: from[0], toStation: to[0], fromLat: from[1], fromLon: 7, toLat: to[1], toLon: 7,
    predictedDeparture: at(-5), predictedArrival: at(30),
    delayMinutes: 20, lat: (from[1] + to[1]) / 2, lon: 7, progress: 0.2,
    delayGainedOnSegmentMinutes: 15, likelyStuck: true, realTime: true,
    ...rest,
  };
}
const B: [string, number] = ["B", 50.1];
const C: [string, number] = ["C", 50.2];

describe("analyseLineAhead", () => {
  it("estimates the hold-up when a train ahead cannot clear a stretch in time", () => {
    // RE 5 left B before your train and only reaches C at +30; yours was due at C at +18.
    const result = analyseLineAhead(yours, 3, [other({ from: B, to: C })], T0);
    expect(result).toEqual({
      status: "held-up",
      atStation: "D",
      officialDelayMinutes: 5,
      estimatedDelayMinutes: { low: 20, high: 25 }, // 5 official + 15 extra
      cause: { trainName: "RE 5", mode: "REGIONAL_RAIL", fromStation: "B", toStation: "C", nearStation: "B", delayMinutes: 20, likelyStuck: true },
      confidence: "likely",
      trainsAhead: 1,
    });
    expect(describeLineAhead(result)).toBe(
      "Officially 5 min late at D; RE 5 ahead is held near B, so expect about 20–25 min late.",
    );
  });

  it("ignores a train that enters the stretch after yours (it is behind you)", () => {
    const behind = other({ from: B, to: C, predictedDeparture: at(12) });
    expect(analyseLineAhead(yours, 3, [behind], T0)).toMatchObject({ status: "clear", trainsAhead: 0 });
  });

  it("ignores trains going the other way, trams, and your own train", () => {
    const others = [
      other({ from: C, to: B }),
      other({ from: B, to: C, mode: "TRAM" }),
      other({ from: B, to: C, tripId: "yours" }),
    ];
    expect(analyseLineAhead(yours, 3, others, T0)).toMatchObject({ status: "clear", trainsAhead: 0 });
  });

  it("ignores trains away from your route", () => {
    const elsewhere = other({ from: ["X", 51.0], to: ["Y", 51.1] });
    expect(analyseLineAhead(yours, 3, [elsewhere], T0)).toMatchObject({ status: "clear", trainsAhead: 0 });
  });

  it("stays quiet when the official prediction already allows for the train ahead", () => {
    // RE 5 reaches C at +12; with the 3-minute gap that is +15, before yours at +18.
    const fine = other({ from: B, to: C, predictedArrival: at(12) });
    expect(analyseLineAhead(yours, 3, [fine], T0)).toMatchObject({ status: "clear", trainsAhead: 1 });
  });

  it("does not report differences under 5 minutes", () => {
    const slight = other({ from: B, to: C, predictedArrival: at(19) }); // +22 with the gap: 4 min extra
    expect(analyseLineAhead(yours, 3, [slight], T0).status).toBe("clear");
  });

  it("hedges when an S-Bahn is ahead of a mainline train", () => {
    const sBahn = other({ from: B, to: C, mode: "SUBURBAN", trainName: "S 6", likelyStuck: false, delayMinutes: 0 });
    const result = analyseLineAhead(yours, 3, [sBahn], T0);
    expect(result).toMatchObject({ status: "held-up", confidence: "possible" });
    expect(describeLineAhead(result)).toContain("S 6 ahead is just ahead on the same line near B (it may use separate tracks)");
  });

  it("does not check a stop the train has already left, or a cancelled run", () => {
    expect(analyseLineAhead(yours, 0, [], T0)).toEqual({ status: "not-checked", reason: "The train has already left that stop" });
    expect(analyseLineAhead({ ...yours, cancelled: true }, 3, [], T0).status).toBe("not-checked");
  });
});

describe("area to query", () => {
  it("covers the stops ahead within the look-ahead window, padded", () => {
    const stretch = stretchAhead(yours, 3, T0);
    expect(stretch.map((s) => s.stationName)).toEqual(["A", "B", "C", "D"]);
    const box = boxAround(stretch, 3);
    expect(box.minLat).toBeCloseTo(50.0 - 3 / 111, 5);
    expect(box.maxLat).toBeCloseTo(50.3 + 3 / 111, 5);
    expect(box.maxLon).toBeGreaterThan(7);
  });

  it("stops at the look-ahead window but always includes the next stop", () => {
    const far: TrainStatus = { ...yours, stopovers: [stop("A", 50.0, undefined, -2), stop("B", 50.1, 50, 51), stop("C", 50.2, 70)] };
    expect(stretchAhead(far, 2, T0).map((s) => s.stationName)).toEqual(["A", "B"]);
  });
});
