// The added value of this tool: check the user's train against the other
// trains ahead of it on its route. If a train ahead is held or slow on a
// stretch the user's train still has to pass, the user's train cannot get
// through before that train clears it, whatever the official prediction
// says. Pure functions; the tool supplies live data.

import type { LineAhead, Stopover, TrainInArea, TrainStatus } from "./types.js";

/** Minimum gap between two trains on the same track, in minutes. */
export const HEADWAY_MINUTES = 3;
/** Only report when it adds at least this much; smaller differences are noise. */
export const MIN_EXTRA_MINUTES = 5;
/** Other trains' endpoints must be this close to a stop on the user's route. */
const SAME_STOP_KM = 0.6;
/** How far ahead to look for trains, in minutes of the user's journey. */
export const LOOKAHEAD_MINUTES = 45;

/** Trams and U-Bahn never share tracks with trains. */
const NON_TRAIN_MODES = new Set(["TRAM", "SUBWAY", "BUS", "COACH"]);

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const arrivalMs = (s: Stopover) => Date.parse(s.predictedArrival ?? s.predictedDeparture ?? "");
const leftMs = (s: Stopover) => Date.parse(s.predictedDeparture ?? s.predictedArrival ?? "");

/** Index of the last stop the train has left, or -1 if it has not departed. */
export function lastPassedIndex(stops: Stopover[], now: number): number {
  let last = -1;
  stops.forEach((s, i) => {
    if (leftMs(s) <= now) last = i;
  });
  return last;
}

/** Stops of the route still ahead within the look-ahead window (for the area query). */
export function stretchAhead(status: TrainStatus, targetIndex: number, now: number): Stopover[] {
  const start = Math.max(0, lastPassedIndex(status.stopovers, now));
  const horizon = now + LOOKAHEAD_MINUTES * 60_000;
  const stops = status.stopovers.slice(start, targetIndex + 1);
  const within = stops.filter((s, i) => i === 0 || arrivalMs(s) <= horizon);
  // Always include at least the next stop.
  return within.length >= 2 ? within : stops.slice(0, 2);
}

/** Bounding box around stops, padded by `padKm`. */
export function boxAround(stops: { lat: number; lon: number }[], padKm = 3) {
  const lats = stops.map((s) => s.lat);
  const lons = stops.map((s) => s.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLat = padKm / 111;
  const dLon = padKm / (111 * Math.cos((midLat * Math.PI) / 180));
  return {
    minLat: Math.min(...lats) - dLat,
    minLon: Math.min(...lons) - dLon,
    maxLat: Math.max(...lats) + dLat,
    maxLon: Math.max(...lons) + dLon,
  };
}

function floor5(n: number): number {
  return Math.floor(n / 5) * 5;
}

export function analyseLineAhead(
  status: TrainStatus,
  targetIndex: number,
  others: TrainInArea[],
  now: number = Date.now(),
): LineAhead {
  const stops = status.stopovers;
  const target = stops[targetIndex];
  if (!target) return { status: "not-checked", reason: "No stop to check against" };
  if (status.cancelled) return { status: "not-checked", reason: "This run is cancelled" };
  const last = lastPassedIndex(stops, now);
  if (last >= targetIndex) return { status: "not-checked", reason: "The train has already left that stop" };

  const start = Math.max(0, last);
  const officialDelay = target.arrivalDelayMinutes ?? target.departureDelayMinutes ?? 0;
  const indexNear = (p: { lat: number; lon: number }): number | undefined => {
    let best: number | undefined;
    let bestKm = SAME_STOP_KM;
    for (let i = start; i <= targetIndex; i++) {
      const d = km(stops[i], p);
      if (d <= bestKm) { best = i; bestKm = d; }
    }
    return best;
  };

  let trainsAhead = 0;
  let worst: { extra: number; train: TrainInArea } | undefined;
  for (const other of others) {
    if (other.tripId === status.tripId || NON_TRAIN_MODES.has(other.mode)) continue;
    const from = indexNear({ lat: other.fromLat, lon: other.fromLon });
    const to = indexNear({ lat: other.toLat, lon: other.toLon });
    // Same direction, on the stretch the user's train still has to cover.
    if (from === undefined || to === undefined || from >= to) continue;
    // Ahead means it entered the stretch first: it left `from` before yours does.
    const yourDeparture = leftMs(stops[from]);
    if (!(Date.parse(other.predictedDeparture) < yourDeparture)) continue;
    trainsAhead++;
    // No overtaking between two stops: your train cannot reach `to` before
    // the train ahead has arrived there plus a safety gap.
    const clears = Math.max(Date.parse(other.predictedArrival), now) + HEADWAY_MINUTES * 60_000;
    const yours = arrivalMs(stops[to]);
    if (!Number.isFinite(clears) || !Number.isFinite(yours)) continue;
    const extra = (clears - yours) / 60_000;
    if (extra >= MIN_EXTRA_MINUTES && (!worst || extra > worst.extra)) worst = { extra, train: other };
  }

  if (!worst) {
    return { status: "clear", atStation: target.stationName, officialDelayMinutes: officialDelay, trainsAhead };
  }

  // Assume no recovery after the hold-up: the extra carries through to your stop.
  const estimate = Math.round(officialDelay + worst.extra);
  const low = Math.max(floor5(estimate), officialDelay + 1);
  const t = worst.train;
  const sameKind = (t.mode === "SUBURBAN") === (status.mode === "SUBURBAN");
  return {
    status: "held-up",
    atStation: target.stationName,
    officialDelayMinutes: officialDelay,
    estimatedDelayMinutes: { low, high: floor5(low) + 5 },
    cause: {
      trainName: t.trainName,
      mode: t.mode,
      fromStation: t.fromStation,
      toStation: t.toStation,
      nearStation: t.progress < 0.5 ? t.fromStation : t.toStation,
      delayMinutes: t.delayMinutes,
      likelyStuck: t.likelyStuck,
    },
    confidence: sameKind ? "likely" : "possible",
    trainsAhead,
  };
}

/** One line for the text diagram, or undefined when there is nothing to say. */
export function describeLineAhead(line: LineAhead): string | undefined {
  if (line.status === "held-up" && line.cause && line.estimatedDelayMinutes) {
    const official = line.officialDelayMinutes && line.officialDelayMinutes >= 1
      ? `Officially ${line.officialDelayMinutes} min late`
      : "Officially on time";
    const what = line.cause.likelyStuck
      ? "is held"
      : line.cause.delayMinutes >= 5
        ? `is running ${line.cause.delayMinutes} min late`
        : "is just ahead on the same line";
    const { low, high } = line.estimatedDelayMinutes;
    const hedge = line.confidence === "possible" ? " (it may use separate tracks)" : "";
    return `${official} at ${line.atStation}; ${line.cause.trainName} ahead ${what} near ${line.cause.nearStation}${hedge}, so expect about ${low}–${high} min late.`;
  }
  if (line.status === "clear" && line.trainsAhead) {
    return `Line ahead: ${line.trainsAhead} train(s) ahead checked, none holding yours up before ${line.atStation}.`;
  }
  return undefined;
}
