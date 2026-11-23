// Plain-text, metro-style diagrams. Text is the one format every client can
// show: terminal agents, desktop apps and plain chat windows alike. Tools
// attach these to their results so the agent can paste them verbatim.

import { describeLineAhead } from "./line-ahead.js";
import type { Culprit, LineAhead, RouteCountries, TrainInArea, TrainNotices, TrainStatus } from "./types.js";

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

/** Whole sentences, up to about 220 characters. */
function brief(text: string): string {
  let out = "";
  for (const sentence of text.match(/(?:[^.]|\.(?=\S))+\.?\s*/g) ?? [text]) {
    if (out && out.length + sentence.length > 220) break;
    out += sentence;
  }
  return out.trim();
}

/** The search for the train that holds the user's train up, as bullet lines. */
function culpritLines(c: Culprit): string[] {
  if (c.status === "not-checked") return [];
  const out: string[] = [];
  if (c.dbReason) out.push(` • DB's reason: ${c.dbReason}`);
  for (const t of c.candidates ?? []) {
    const late = t.evidence.includes("running late") || t.delayMinutes >= 1 ? `+${t.delayMinutes} min, ` : "";
    out.push(` • ${t.confidence === "likely" ? "Likely" : "Possibly"} ${t.trainName}, ${t.where}: ${late}${t.evidence.join(", ")}`);
  }
  if (c.status === "none-found") out.push(" • No train ahead could be identified as the cause");
  if (c.queuedBehind?.length) out.push(` • Also late, but left after it: ${c.queuedBehind.join(", ")}`);
  for (const f of c.otherFaults ?? []) out.push(` • Fault on the same line, direction unknown: ${f}`);
  for (const n of c.notices ?? []) out.push(` • DB notice on this line (${n.stations[0]}): ${brief(n.text)}`);
  return out;
}

/**
 * One train's route as a vertical line: ● stops already passed, ○ stops
 * ahead, ▼ where the train is now, with the delay at every stop.
 */
export function renderTrainStrip(
  status: TrainStatus,
  now: number = Date.now(),
  boardingStopIndex?: number,
  notices?: TrainNotices,
  lineAhead?: LineAhead,
  countries?: RouteCountries,
  culprit?: Culprit,
): string {
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
    // Only the current platform is shown. The feed's "scheduled" platform is
    // often an internal code (e.g. 88, 89), so a "changed from" claim would
    // raise false alarms.
    if (i === boardingStopIndex) {
      if (stop.track) notes.push(`platform ${stop.track}`);
      notes.push("← you board here");
    }
    const row = ` ${marker}  ${fit(stop.stationName, NAME_WIDTH)} ${time}  ${delay.padEnd(8)} ${notes.join(", ")}`;
    lines.push(row.trimEnd());
    if (i === lastPassed && i < status.stopovers.length - 1 && status.realTime) {
      lines.push(" ▼  train is around here");
    }
  });

  if (lastPassed === -1) lines.push("(not departed yet)");
  const ahead = lineAhead ? describeLineAhead(lineAhead) : undefined;
  if (ahead) lines.push("", ahead);
  if (notices?.status === "ok" && notices.notices && notices.notices.length > 0) {
    lines.push("", `DB notices at ${notices.station}:`);
    for (const n of notices.notices) lines.push(` • ${n.text}`);
  }
  const why = culprit ? culpritLines(culprit) : [];
  if (why.length > 0) lines.push("", "What may be holding it up:", ...why);
  for (const part of countries?.status === "crosses-border" ? countries.abroad ?? [] : []) {
    const stretch = part.stops.length > 1 ? `${part.stops[0]} → ${part.stops[part.stops.length - 1]}` : part.stops[0];
    lines.push("", `Outside Germany: ${stretch} (${part.countryName}). German sources have no disruption notices there.`);
  }
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
    const flag = [train.likelyStuck ? "⚠ likely stuck" : "", train.feedsDisagree ? "⚠ feeds disagree" : ""]
      .filter(Boolean)
      .map((f) => `  ${f}`)
      .join("");
    lines.push(
      `${delay} min  ${fit(train.trainName, 14)} ${train.fromStation} ●${track}○ ${train.toStation}${flag}`,
    );
  }
  if (trains.length > MAX_LATE_TRAINS) {
    lines.push(`… and ${trains.length - MAX_LATE_TRAINS} more`);
  }
  return lines.join("\n");
}
