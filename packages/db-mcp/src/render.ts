// Plain-text, metro-style diagrams. Text is the one format every client can
// show: terminal agents, desktop apps and plain chat windows alike. Tools
// attach these to their results so the agent can paste them verbatim.

import type { TrainInArea, TrainStatus } from "./types.js";

const NAME_WIDTH = 30;
const TRACK_WIDTH = 9;
const MAX_LATE_TRAINS = 12;

const clock = new Intl.DateTimeFormat("de-DE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});

function hhmm(iso: string | undefined): string {
  if (!iso) return "     ";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "     " : clock.format(ms);
}

function fit(text: string, width: number): string {
  const short = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return short.padEnd(width);
}

function delayLabel(minutes: number | undefined): string {
  if (minutes === undefined) return "";
  if (minutes >= 1) return `+${minutes} min`;
  if (minutes <= -1) return `${minutes} min`;
  return "on time";
}

/**
 * One train's route as a vertical line: ● stops already passed, ○ stops
 * ahead, ▼ where the train is now, with the delay at every stop.
 */
export function renderTrainStrip(status: TrainStatus, now: number = Date.now()): string {
  const lines: string[] = [];
  const liveNote = status.realTime ? "live" : "timetable only, no live data";
  lines.push(`${status.name} → ${status.headsign}  (${liveNote})`);
  if (status.cancelled) lines.push("✕ this run is cancelled");

  const passed = status.stopovers.map((stop) => {
    const leftAt = stop.predictedDeparture ?? stop.predictedArrival;
    return leftAt !== undefined && Date.parse(leftAt) <= now;
  });
  const lastPassed = passed.lastIndexOf(true);

  status.stopovers.forEach((stop, i) => {
    const marker = stop.cancelled ? "✕" : passed[i] ? "●" : "○";
    const time = hhmm(stop.scheduledDeparture ?? stop.scheduledArrival);
    const delay = delayLabel(stop.arrivalDelayMinutes ?? stop.departureDelayMinutes);
    const notes: string[] = [];
    if (stop.cancelled) notes.push("stop cancelled");
    if (stop.track && stop.scheduledTrack && stop.track !== stop.scheduledTrack) {
      notes.push(`platform ${stop.track} (was ${stop.scheduledTrack})`);
    }
    const row = ` ${marker}  ${fit(stop.stationName, NAME_WIDTH)} ${time}  ${delay.padEnd(8)} ${notes.join(", ")}`;
    lines.push(row.trimEnd());
    if (i === lastPassed && i < status.stopovers.length - 1 && status.realTime) {
      lines.push(" ▼  train is around here");
    }
  });

  if (lastPassed === -1) lines.push("(not departed yet)");
  return lines.join("\n");
}

/**
 * Late trains as one line each: the two stops the train is between, joined
 * by a track with ▶ at the train's estimated position.
 */
export function renderLateTrains(
  trains: TrainInArea[],
  summary: { trainsChecked: number },
): string {
  const stuck = trains.filter((t) => t.likelyStuck).length;
  const lines = [
    `${trains.length} of ${summary.trainsChecked} trains late, ${stuck} likely stuck`,
  ];
  if (trains.length === 0) return lines.join("\n");

  for (const train of trains.slice(0, MAX_LATE_TRAINS)) {
    const at = Math.min(TRACK_WIDTH - 1, Math.floor(train.progress * TRACK_WIDTH));
    const track = `${"━".repeat(at)}▶${"━".repeat(TRACK_WIDTH - 1 - at)}`;
    const delay = `+${train.delayMinutes}`.padStart(5);
    const flag = train.likelyStuck ? "  ⚠ likely stuck" : "";
    lines.push(
      `${delay} min  ${fit(train.trainName, 14)} ${train.fromStation} ●${track}○ ${train.toStation}${flag}`,
    );
  }
  if (trains.length > MAX_LATE_TRAINS) {
    lines.push(`… and ${trains.length - MAX_LATE_TRAINS} more`);
  }
  return lines.join("\n");
}
