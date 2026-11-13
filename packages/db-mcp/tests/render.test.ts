import { describe, expect, it } from "vitest";
import { renderLateTrains, renderTrainStrip } from "../src/render.js";
import type { Stopover, TrainInArea, TrainStatus } from "../src/types.js";

function stop(name: string, over: Partial<Stopover> = {}): Stopover {
  return { stationName: name, stationId: name, lat: 0, lon: 0, cancelled: false, alerts: [], ...over };
}

const status: TrainStatus = {
  tripId: "t",
  name: "ICE 107",
  headsign: "Basel SBB",
  mode: "HIGHSPEED_RAIL",
  realTime: true,
  cancelled: false,
  alerts: [],
  stopovers: [
    stop("Dortmund Hbf", { scheduledDeparture: "2026-11-13T10:00:00Z", predictedDeparture: "2026-11-13T10:10:00Z", departureDelayMinutes: 10 }),
    stop("Düsseldorf Hbf", { scheduledArrival: "2026-11-13T10:50:00Z", predictedArrival: "2026-11-13T11:15:00Z", scheduledDeparture: "2026-11-13T10:52:00Z", predictedDeparture: "2026-11-13T11:17:00Z", arrivalDelayMinutes: 25 }),
    stop("Köln Hbf", { scheduledArrival: "2026-11-13T11:15:00Z", predictedArrival: "2026-11-13T11:54:00Z", arrivalDelayMinutes: 39, track: "6", scheduledTrack: "88" }),
  ],
};

describe("renderTrainStrip", () => {
  it("marks passed stops, the train's position, delays and platform changes", () => {
    const text = renderTrainStrip(status, Date.parse("2026-11-13T11:30:00Z"));
    expect(text.split("\n")).toEqual([
      "ICE 107 → Basel SBB  (live)",
      " ●  Dortmund Hbf                   11:00  +10 min",
      " ●  Düsseldorf Hbf                 11:52  +25 min",
      " ▼  train is around here",
      " ○  Köln Hbf                       12:15  +39 min  platform 6 (was 88)",
    ]);
  });

  it("says when the train has not departed and when there is no live data", () => {
    const text = renderTrainStrip({ ...status, realTime: false }, Date.parse("2026-11-13T09:00:00Z"));
    expect(text).toContain("(timetable only, no live data)");
    expect(text).toContain("(not departed yet)");
    expect(text).not.toContain("▼");
  });

  it("marks cancelled runs and stops", () => {
    const cancelled: TrainStatus = {
      ...status,
      cancelled: true,
      stopovers: [stop("Köln Hbf", { cancelled: true, scheduledDeparture: "2026-11-13T11:15:00Z" })],
    };
    const text = renderTrainStrip(cancelled, Date.parse("2026-11-13T09:00:00Z"));
    expect(text).toContain("✕ this run is cancelled");
    expect(text).toContain(" ✕  Köln Hbf");
    expect(text).toContain("stop cancelled");
  });
});

function train(over: Partial<TrainInArea>): TrainInArea {
  return {
    tripId: "t",
    trainName: "RE1 (26814)",
    mode: "REGIONAL_RAIL",
    fromStation: "Leverkusen Mitte",
    toStation: "Köln Mülheim",
    delayMinutes: 89,
    lat: 51,
    lon: 7,
    progress: 0.5,
    delayGainedOnSegmentMinutes: 0,
    likelyStuck: false,
    realTime: true,
    ...over,
  };
}

describe("renderLateTrains", () => {
  it("draws one line per train with its position between two stops", () => {
    const text = renderLateTrains(
      [train({}), train({ trainName: "ICE 158", delayMinutes: 59, progress: 0, likelyStuck: true, fromStation: "Mönchengladbach Hbf", toStation: "Venlo" })],
      { trainsChecked: 40 },
    );
    expect(text.split("\n")).toEqual([
      "2 of 40 trains late, 1 likely stuck",
      "  +89 min  RE1 (26814)    Leverkusen Mitte ●━━━━▶━━━━○ Köln Mülheim",
      "  +59 min  ICE 158        Mönchengladbach Hbf ●▶━━━━━━━━○ Venlo  ⚠ likely stuck",
    ]);
  });

  it("keeps the marker on the track at the end of a segment and caps the list at 12", () => {
    const many = Array.from({ length: 15 }, () => train({ progress: 1 }));
    const lines = renderLateTrains(many, { trainsChecked: 15 }).split("\n");
    expect(lines).toHaveLength(14);
    expect(lines[1]).toContain("●━━━━━━━━▶○");
    expect(lines[13]).toBe("… and 3 more");
  });

  it("handles no late trains", () => {
    expect(renderLateTrains([], { trainsChecked: 12 })).toBe("0 of 12 trains late, 0 likely stuck");
  });
});
