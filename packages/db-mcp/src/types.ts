// Shared domain types: the shapes our tools return. The Transitous client
// maps the upstream (MOTIS) response shapes into these.

export type DataSource = "transitous" | "dwd";

export interface SourcedResponse<T> {
  data: T;
  source: DataSource;
}

export interface Station {
  /** Opaque stop ID. Pass it back unchanged to the other tools. */
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/** One departure from a station board. */
export interface Departure {
  /** Opaque trip ID, input to get_train_status. */
  tripId: string;
  /** Human-facing name, e.g. "ICE 107", "RE1 (26814)", "S19". */
  trainName: string;
  /** Where the train is heading. */
  headsign: string;
  /** Upstream mode, e.g. HIGHSPEED_RAIL, REGIONAL_RAIL, SUBURBAN, TRAM. */
  mode: string;
  scheduledDeparture: string; // ISO 8601
  predictedDeparture: string; // ISO 8601
  delayMinutes: number;
  track?: string;
  scheduledTrack?: string;
  cancelled: boolean;
  /** False when the times are timetable-only (no live data for this trip). */
  realTime: boolean;
}

export interface Stopover {
  stationName: string;
  stationId: string;
  lat: number;
  lon: number;
  scheduledArrival?: string; // ISO 8601, absent for origin
  predictedArrival?: string;
  scheduledDeparture?: string; // absent for terminus
  predictedDeparture?: string;
  arrivalDelayMinutes?: number;
  departureDelayMinutes?: number;
  track?: string;
  scheduledTrack?: string;
  cancelled: boolean;
  /** Service alerts attached to this stop, as plain text. */
  alerts: string[];
}

export interface TrainStatus {
  tripId: string;
  /** Human-facing name, e.g. "ICE 107". */
  name: string;
  headsign: string;
  mode: string;
  /** False when the times are timetable-only (no live data for this trip). */
  realTime: boolean;
  cancelled: boolean;
  stopovers: Stopover[];
  /** Trip-level service alerts, as plain text. */
  alerts: string[];
}

export interface JourneyLeg {
  /** Train name, or "WALK" for a footpath between platforms/stations. */
  trainName: string;
  mode: string;
  /** Present for transit legs; input to get_train_status. */
  tripId?: string;
  from: Station;
  to: Station;
  scheduledDeparture: string;
  predictedDeparture: string;
  scheduledArrival: string;
  predictedArrival: string;
  departureDelayMinutes: number;
  arrivalDelayMinutes: number;
  cancelled: boolean;
  realTime: boolean;
}

export interface JourneyOption {
  legs: JourneyLeg[];
  /** Transfers flagged when the live gap between two trains is under the buffer. */
  riskyTransfers: Array<{ atStation: string; reason: string }>;
}

/** A train currently moving between two stops, for area/map queries. */
export interface TrainInArea {
  tripId: string;
  trainName: string;
  mode: string;
  fromStation: string;
  toStation: string;
  /** Predicted delay at the next stop, in minutes. */
  delayMinutes: number;
  /** Estimated current position, interpolated between the two stops. */
  lat: number;
  lon: number;
  /** Minutes of delay added between the last stop and the next one. */
  delayGainedOnSegmentMinutes: number;
  /**
   * True when the train is losing 10+ minutes between two stops, i.e. it is
   * probably held or crawling right now. An inference from live predictions,
   * not a confirmed standstill.
   */
  likelyStuck: boolean;
  realTime: boolean;
}

/** A weather warning from DWD (Deutscher Wetterdienst). */
export interface WeatherWarning {
  /** DWD event code, e.g. "HITZE", "GEWITTER", "STURM", "SCHNEE". */
  type: string;
  /** DWD's official severity: 1 = advisory, 2 = severe, 3 = very severe, 4 = extreme. */
  level: 1 | 2 | 3 | 4;
  headline: string;
  description: string;
  /** ISO 8601 timestamp when the warning starts being valid. */
  start: string;
  /** ISO 8601 timestamp when the warning expires. */
  end: string;
  /** DWD's human-readable area name, e.g. "Stadt Köln". */
  areaName: string;
}
