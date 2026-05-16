// Shared domain types. These are the shapes our tools return, regardless of
// whether the data came from marudor or db-rest. Each provider client maps
// its own response shape into these types.

export type DataSource = "marudor" | "db-rest";

export interface SourcedResponse<T> {
  data: T;
  source: DataSource;
  /** True when we fell back from marudor to db-rest. The skill surfaces this. */
  degraded: boolean;
}

export interface Station {
  evaNumber: string;
  name: string;
  /** Lower is better — caller can sort or pick top match. */
  matchScore?: number;
}

export interface TrainIdentifier {
  /** Internal journey ID used by subsequent get_train_status calls. */
  journeyId: string;
  /** Human-facing train name, e.g. "ICE 597". */
  name: string;
  /** First station of the run. */
  origin: string;
  /** Final station of the run. */
  destination: string;
  /** Operating date in YYYY-MM-DD. */
  date: string;
}

export interface OutgoingConnection {
  trainName: string;
  destination: string;
  scheduledDeparture: string; // ISO 8601
  predictedDeparture: string; // ISO 8601
  delayMinutes: number;
  /** Marudor flag — true when DB has committed to holding this connection. */
  willBeHeld?: boolean;
}

export interface Stopover {
  stationName: string;
  evaNumber: string;
  scheduledArrival?: string; // ISO 8601, absent for origin
  predictedArrival?: string;
  scheduledDeparture?: string; // absent for terminus
  predictedDeparture?: string;
  arrivalDelayMinutes?: number;
  departureDelayMinutes?: number;
  platformScheduled?: string;
  platformActual?: string;
  cancelled?: boolean;
  /** Trains departing from this station that connect from the current one. */
  outgoingConnections: OutgoingConnection[];
  /** Free-text messages attached to this stop. */
  messages: string[];
}

export interface TrainStatus {
  identifier: TrainIdentifier;
  stopovers: Stopover[];
  /** Train-level messages, e.g. "Wagen 7 fällt aus", "Ersatzfahrt". */
  messages: string[];
  cancelled: boolean;
}

export interface JourneyLeg {
  trainName: string;
  from: Station;
  to: Station;
  scheduledDeparture: string;
  predictedDeparture: string;
  scheduledArrival: string;
  predictedArrival: string;
  departureDelayMinutes: number;
  arrivalDelayMinutes: number;
}

export interface JourneyOption {
  legs: JourneyLeg[];
  /** Transfers flagged when (transferTime - bufferThreshold) < incoming delay. */
  riskyTransfers: Array<{ atStation: string; reason: string }>;
}

export interface Disruption {
  id: string;
  headline: string;
  description: string;
  /** Severity is approximate; "high" maps to Stellwerk/Personen-im-Gleis classes. */
  severity: "low" | "medium" | "high";
  affectedSegments: string[];
  startTime?: string;
  expectedEndTime?: string;
}
