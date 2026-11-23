// "Which train is holding mine up?" DB says "technical fault on another
// train" but never which one. This looks for it: trains ahead of the user's
// on the same stretch of line, whether they are held or late, and whether DB
// has posted a fault of their own. It names suspects with the evidence, never
// a certainty. Pure functions; the tool supplies live data.

import type { BoardTrain } from "./clients/open-boards.js";
import { isNumberedTrain } from "./clients/transitous.js";
import { CODE_TEXT } from "./db/codes.js";
import type { Culprit, CulpritCandidate, Stopover, TrainInArea, TrainStatus } from "./types.js";

/** Delays below this need no explaining. */
export const MIN_DELAY_TO_EXPLAIN = 10;
/** DB reasons that mean this train itself has a problem. */
const OWN_FAULT = new Set([36, 61, 63]);
/** DB reasons that blame a different train. */
const OTHER_TRAIN = new Set([43, 45, 46, 55].map((c) => CODE_TEXT[c]));
const MIN_ORDER_GAP_MINUTES = 10;
const NEAR_LINE_KM = 0.5;
const SAME_STOP_KM = 0.8;
const NON_TRAIN_MODES = new Set(["TRAM", "SUBWAY", "BUS", "COACH"]);

type Point = [lat: number, lon: number];

function km(a: Point, b: Point): number {
  const dLat = (a[0] - b[0]) * 111.2;
  const dLon = (a[1] - b[1]) * 111.2 * Math.cos(((a[0] + b[0]) * Math.PI) / 360);
  return Math.hypot(dLat, dLon);
}

/** Nearest vertex of the route line, and how far away it is. */
function nearest(path: Point[], p: Point): { index: number; km: number } {
  let index = 0;
  let best = Infinity;
  path.forEach((v, i) => {
    const d = km(v, p);
    if (d < best) { best = d; index = i; }
  });
  return { index, km: best };
}

/**
 * Trains running the same way along the user's route between two of its
 * stops. An express passes local stations without stopping, so other trains
 * are matched to the route line, not to the express's stops.
 */
export function trainsOnStretch(
  status: TrainStatus,
  fromStop: number,
  toStop: number,
  others: TrainInArea[],
): TrainInArea[] {
  const path = status.path ?? [];
  if (path.length < 2) return [];
  const at = (s: Stopover) => nearest(path, [s.lat, s.lon]).index;
  const start = at(status.stopovers[fromStop]);
  const end = at(status.stopovers[toStop]);
  return others.filter((o) => {
    if (o.tripId === status.tripId || NON_TRAIN_MODES.has(o.mode)) return false;
    // Another feed's record of the user's own train.
    if (isNumberedTrain(status.name) && o.trainName === status.name) return false;
    const a = nearest(path, [o.fromLat, o.fromLon]);
    const b = nearest(path, [o.toLat, o.toLon]);
    if (a.km > NEAR_LINE_KM || b.km > NEAR_LINE_KM) return false;
    return a.index < b.index && b.index > start && a.index < end;
  });
}

/** Did the other train leave the user's last stop before the user's train did? */
export function orderOf(mine: Stopover, other: TrainStatus | undefined): "ahead" | "behind" | "unknown" {
  if (!other?.realTime) return "unknown";
  const stop = other.stopovers.find((s) => km([s.lat, s.lon], [mine.lat, mine.lon]) <= SAME_STOP_KM);
  const theirs = Date.parse(stop?.predictedDeparture ?? stop?.predictedArrival ?? "");
  const ours = Date.parse(mine.predictedDeparture ?? mine.predictedArrival ?? "");
  if (Number.isNaN(theirs) || Number.isNaN(ours) || stop?.cancelled) return "unknown";
  // Passed stops often still carry timetable times, so a small gap proves nothing.
  if (Math.abs(theirs - ours) < MIN_ORDER_GAP_MINUTES * 60_000) return "unknown";
  return theirs < ours ? "ahead" : "behind";
}

/** The order from DB's recorded departures at one station, if it has both trains. */
export function orderOnBoard(board: BoardTrain[], mine: string, other: string): "ahead" | "behind" | undefined {
  const time = (n: string) => Date.parse(board.find((t) => t.number === n)?.time ?? "");
  const ours = time(mine), theirs = time(other);
  if (Number.isNaN(ours) || Number.isNaN(theirs)) return undefined;
  return theirs < ours ? "ahead" : "behind";
}

const lineOf = (name: string) => name.replace(/\(.*\)/, "").replace(/\s+/g, "").toUpperCase();

export function findCulprit(input: {
  delayMinutes: number;
  /** Mode of the user's train. */
  mode: string;
  suspects: Array<{ train: TrainInArea; number?: string; order: "ahead" | "behind" | "unknown" }>;
  /** DB boards along the stretch; empty without a DB key. */
  boards: Array<{ station: string; trains: BoardTrain[] }>;
  /** DB's reasons for the user's own train. */
  ownReasons: string[];
}): Culprit {
  const faults = new Map<string, Set<string>>();
  for (const { trains } of input.boards) {
    for (const t of trains) {
      for (const c of t.causes.filter((c) => OWN_FAULT.has(c))) {
        faults.set(t.number, (faults.get(t.number) ?? new Set()).add(CODE_TEXT[c]));
      }
    }
  }

  // DB gave a reason that is not another train: then a suspect is a side note.
  const otherCause = input.ownReasons.length > 0 && !input.ownReasons.some((r) => OTHER_TRAIN.has(r));
  const candidates: CulpritCandidate[] = [];
  const queuedBehind: string[] = [];
  for (const { train, number, order } of input.suspects) {
    const label = number && !train.trainName.includes(number) ? `${train.trainName} (${number})` : train.trainName;
    if (order === "behind") {
      if (train.delayMinutes >= 5) queuedBehind.push(`${label} +${train.delayMinutes} min`);
      continue;
    }
    const fault = number ? faults.get(number) : undefined;
    const evidence: string[] = [];
    if (fault) evidence.push(...[...fault].map((f) => `DB: ${f}`));
    if (train.likelyStuck) evidence.push("appears held or crawling");
    else if (train.delayMinutes >= MIN_DELAY_TO_EXPLAIN) evidence.push("running late");
    if (order === "ahead") evidence.push("left before your train");
    const held = train.likelyStuck || (order === "ahead" && train.delayMinutes >= MIN_DELAY_TO_EXPLAIN);
    // An S-Bahn and a mainline train often have their own tracks.
    const mixed = (train.mode === "SUBURBAN") !== (input.mode === "SUBURBAN");
    if (!train.realTime || (!fault && (!held || (mixed && !train.likelyStuck)))) continue;
    if (mixed) evidence.push("may use separate tracks");
    candidates.push({
      trainName: label,
      where: `${train.fromStation} → ${train.toStation}`,
      delayMinutes: train.delayMinutes,
      confidence: order === "ahead" && fault && !otherCause && !mixed ? "likely" : "possible",
      evidence,
    });
  }
  candidates.sort((a, b) => Number(b.confidence === "likely") - Number(a.confidence === "likely") || b.delayMinutes - a.delayMinutes);

  // Trains of lines seen on this stretch with a fault of their own, but not
  // known to be ahead: they may run the other way. Reported, not accused.
  const lines = new Set(input.suspects.map((s) => lineOf(s.train.trainName)));
  const named = new Set(input.suspects.map((s) => s.number));
  const otherFaults = new Map<string, string>();
  for (const { station, trains } of input.boards) {
    for (const t of trains) {
      const fault = faults.get(t.number);
      if (!fault || named.has(t.number) || !lines.has(lineOf(t.name))) continue;
      otherFaults.set(t.number, `${t.name} (${t.number}): ${[...fault].join(", ")}, seen at ${station}`);
    }
  }

  // What DB says is wrong around here, without long-running building sites.
  const notices = new Map<string, { text: string; stations: string[] }>();
  for (const { station, trains } of input.boards) {
    for (const d of trains.filter((t) => lines.has(lineOf(t.name))).flatMap((t) => t.disruptions)) {
      if (d.cause === "CONSTRUCTION") continue;
      const entry = notices.get(d.id) ?? { text: d.text, stations: [] };
      if (!entry.stations.includes(station)) entry.stations.push(station);
      notices.set(d.id, entry);
    }
  }

  return {
    status: candidates.length > 0 ? "candidates" : "none-found",
    dbReason: input.ownReasons[0],
    candidates: candidates.slice(0, 3),
    queuedBehind: queuedBehind.slice(0, 3),
    otherFaults: [...otherFaults.values()].slice(0, 3),
    notices: [...notices.values()].slice(0, 3),
  };
}
