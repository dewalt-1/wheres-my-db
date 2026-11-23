// Shared domain types: the shapes our tools return. The Transitous client
// maps the upstream (MOTIS) response shapes into these.

export type DataSource = "transitous" | "dwd";

export interface SourcedResponse<T> {
  data: T;
  source: DataSource;
  /** Optional plain-text diagram of the data, for the agent to show as-is. */
  diagram?: string;
  /** Optional link to the live map showing the same data. */
  mapUrl?: string;
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
  /** Run number without category or leading zeros, e.g. "107", "26814". */
  trainNumber?: string;
  headsign: string;
  mode: string;
  /** False when the times are timetable-only (no live data for this trip). */
  realTime: boolean;
  cancelled: boolean;
  stopovers: Stopover[];
  /** Route line as [lat, lon]; used internally, not returned by the tool. */
  path?: Array<[number, number]>;
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
  /** Coordinates of the stop it last left and the one it is heading to. */
  /** Upstream stop id of the last stop; German ones contain DB's stop code. */
  fromStopId?: string;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  /** Predicted departure from the last stop and arrival at the next (ISO 8601). */
  predictedDeparture: string;
  predictedArrival: string;
  /** Predicted delay at the next stop, in minutes. */
  delayMinutes: number;
  /** Estimated current position, interpolated between the two stops. */
  lat: number;
  lon: number;
  /** How far along the current segment the train is, from 0 to 1. */
  progress: number;
  /** Minutes of delay added between the last stop and the next one. */
  delayGainedOnSegmentMinutes: number;
  /**
   * True when the train is losing 10+ minutes between two stops, i.e. it is
   * probably held or crawling right now. An inference from live predictions,
   * not a confirmed standstill.
   */
  likelyStuck: boolean;
  /** Two feeds report this run and give clearly different delays or positions. */
  feedsDisagree?: boolean;
  realTime: boolean;
}

/**
 * The user's train checked against other trains ahead of it on its route.
 * status "held-up": a train ahead cannot clear a stretch your train still
 * has to pass in time, so your train will likely be later than the official
 * prediction. status "clear": trains ahead were checked and none holds it
 * up. status "not-checked": see `reason`.
 */
export interface LineAhead {
  status: "held-up" | "clear" | "not-checked";
  reason?: string;
  /** The stop the estimate is for: where the user boards, else the next stop. */
  atStation?: string;
  officialDelayMinutes?: number;
  /** Estimated delay at atStation, as a 5-minute range. */
  estimatedDelayMinutes?: { low: number; high: number };
  /** The train ahead that holds yours up. */
  cause?: {
    trainName: string;
    mode: string;
    fromStation: string;
    toStation: string;
    /** The station it is closest to now. */
    nearStation: string;
    delayMinutes: number;
    likelyStuck: boolean;
  };
  /** likely: both trains use the same kind of tracks. possible: they may run on separate tracks. */
  confidence?: "likely" | "possible";
  /** Trains found ahead on the same stretch and direction. */
  trainsAhead?: number;
}

/** A notice DB has attached to a train at a station. */
export interface Notice {
  /** delay-reason: why it is late. quality: catering, coaches, bikes, Wi-Fi, etc. disruption: a published disruption notice. */
  kind: "delay-reason" | "quality" | "disruption";
  /** Plain-English text. */
  text: string;
  /** DB message code, when there is one. */
  code?: number;
  /** When DB published it (ISO 8601), when known. */
  since?: string;
}

/**
 * DB notices for one train at one station.
 * status "off": no DB API key is configured, so DB notices are not available.
 * status "ok": looked up; `notices` may be empty, meaning DB published none.
 * status "station-not-found": the station could not be matched in DB's data.
 * status "not-covered": DB publishes notices for trains only, not trams, U-Bahn or buses.
 * status "error": the DB API failed; `message` says why.
 */
export interface TrainNotices {
  status: "off" | "ok" | "station-not-found" | "not-covered" | "error";
  station?: string;
  notices?: Notice[];
  message?: string;
}

/**
 * Which part of the train's remaining route is outside Germany. German
 * sources (Transitous' German feed, DB) don't carry disruption notices for
 * other countries, so the agent should check that country's operator.
 */
export interface RouteCountries {
  status: "germany-only" | "crosses-border" | "not-checked";
  abroad?: Array<{
    /** ISO country code, e.g. "NL". */
    country: string;
    countryName: string;
    stops: string[];
  }>;
  reason?: string;
}

/** A train that may be holding the user's train up, with the evidence. */
export interface CulpritCandidate {
  trainName: string;
  where: string;
  delayMinutes: number;
  /** "likely": left before the user's train and DB reports a fault on it. Never certain. */
  confidence: "likely" | "possible";
  evidence: string[];
}

/** Search for the train that is holding the user's train up. */
export interface Culprit {
  status: "candidates" | "none-found" | "not-checked";
  reason?: string;
  /** DB's latest reason for the user's train, e.g. "Technical fault on another train". */
  dbReason?: string;
  candidates?: CulpritCandidate[];
  /** Late trains that left after the user's train: queued too, not the cause. */
  queuedBehind?: string[];
  /** Trains of the same lines with a fault of their own; may run the other way. */
  otherFaults?: string[];
  /** DB's disruption texts at stations along the stretch. */
  notices?: Array<{ text: string; stations: string[] }>;
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
