// Client for the Transitous API (https://transitous.org), a community-run
// MOTIS instance fed by public GTFS + GTFS-Realtime data. One client covers
// stations, departure boards, per-stop trip status, journey planning and
// "trains currently in this area".
//
// Every method maps the upstream shape into our domain types (../types.ts)
// and throws ProviderError("transitous", ...) on failure.

import { ProviderError } from "../errors.js";
import type {
  Departure,
  JourneyLeg,
  JourneyOption,
  Station,
  Stopover,
  TrainInArea,
  TrainStatus,
} from "../types.js";

const DEFAULT_BASE_URL = "https://api.transitous.org";
const DEFAULT_TIMEOUT_MS = 15000;
// Transitous asks automated clients to identify themselves. Override with
// the DB_MCP_USER_AGENT environment variable or the userAgent option.
const DEFAULT_USER_AGENT = "db-mcp/0.2";

/** Rail modes, as named by the upstream API. Buses, ferries etc. are excluded. */
export const RAIL_MODES = [
  "HIGHSPEED_RAIL",
  "LONG_DISTANCE",
  "NIGHT_RAIL",
  "REGIONAL_FAST_RAIL",
  "REGIONAL_RAIL",
  "SUBURBAN",
  "SUBWAY",
  "TRAM",
] as const;
const RAIL_MODE_SET: ReadonlySet<string> = new Set(RAIL_MODES);

/** A train losing at least this much time between two stops is flagged likelyStuck. */
const STUCK_MIN_GAIN_MINUTES = 10;

export interface TransitousClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
}

// ---------------------------------------------------------------------------
// Raw upstream shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface RawAlert {
  headerText?: unknown;
  descriptionText?: unknown;
}

interface RawPlace {
  name?: unknown;
  stopId?: unknown;
  lat?: unknown;
  lon?: unknown;
  arrival?: unknown;
  departure?: unknown;
  scheduledArrival?: unknown;
  scheduledDeparture?: unknown;
  track?: unknown;
  scheduledTrack?: unknown;
  cancelled?: unknown;
  alerts?: RawAlert[];
}

interface RawStopTime {
  place?: RawPlace;
  mode?: unknown;
  realTime?: unknown;
  headsign?: unknown;
  tripId?: unknown;
  displayName?: unknown;
  routeShortName?: unknown;
  tripShortName?: unknown;
  cancelled?: unknown;
  tripCancelled?: unknown;
}

interface RawLeg {
  mode?: unknown;
  realTime?: unknown;
  headsign?: unknown;
  tripId?: unknown;
  displayName?: unknown;
  routeShortName?: unknown;
  tripShortName?: unknown;
  cancelled?: unknown;
  from?: RawPlace;
  to?: RawPlace;
  intermediateStops?: RawPlace[];
  startTime?: unknown;
  endTime?: unknown;
  scheduledStartTime?: unknown;
  scheduledEndTime?: unknown;
  alerts?: RawAlert[];
}

interface RawMapSegment {
  trips?: Array<{ tripId?: unknown; displayName?: unknown }>;
  mode?: unknown;
  from?: RawPlace;
  to?: RawPlace;
  departure?: unknown;
  arrival?: unknown;
  scheduledDeparture?: unknown;
  scheduledArrival?: unknown;
  realTime?: unknown;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Whole minutes from scheduled to predicted; undefined if either is missing. */
function delayMinutes(scheduled?: string, predicted?: string): number | undefined {
  if (!scheduled || !predicted) return undefined;
  const s = Date.parse(scheduled);
  const p = Date.parse(predicted);
  if (Number.isNaN(s) || Number.isNaN(p)) return undefined;
  return Math.round((p - s) / 60000);
}

function alertTexts(alerts: RawAlert[] | undefined): string[] {
  if (!Array.isArray(alerts)) return [];
  const out: string[] = [];
  for (const a of alerts) {
    const text = [str(a?.headerText), str(a?.descriptionText)]
      .filter((x): x is string => x !== undefined)
      .join(": ");
    if (text) out.push(text);
  }
  return out;
}

function trainNameOf(raw: {
  displayName?: unknown;
  routeShortName?: unknown;
  tripShortName?: unknown;
  mode?: unknown;
}): string {
  return (
    str(raw.displayName) ??
    str(raw.tripShortName) ??
    str(raw.routeShortName) ??
    str(raw.mode) ??
    ""
  );
}

/** "ICE 107", "ice107" and "Ice  107" all normalise to "ICE107". */
function normaliseName(name: string): string {
  return name.toUpperCase().replace(/\s+/g, "");
}

function mapStation(place: RawPlace | undefined): Station {
  return {
    id: str(place?.stopId) ?? "",
    name: str(place?.name) ?? "",
    lat: num(place?.lat) ?? 0,
    lon: num(place?.lon) ?? 0,
  };
}

function mapStopover(place: RawPlace): Stopover {
  const scheduledArrival = str(place.scheduledArrival);
  const predictedArrival = str(place.arrival);
  const scheduledDeparture = str(place.scheduledDeparture);
  const predictedDeparture = str(place.departure);
  return {
    stationName: str(place.name) ?? "",
    stationId: str(place.stopId) ?? "",
    lat: num(place.lat) ?? 0,
    lon: num(place.lon) ?? 0,
    scheduledArrival,
    predictedArrival,
    scheduledDeparture,
    predictedDeparture,
    arrivalDelayMinutes: delayMinutes(scheduledArrival, predictedArrival),
    departureDelayMinutes: delayMinutes(scheduledDeparture, predictedDeparture),
    track: str(place.track),
    scheduledTrack: str(place.scheduledTrack),
    cancelled: place.cancelled === true,
    alerts: alertTexts(place.alerts),
  };
}

// ---------------------------------------------------------------------------
// TransitousClient
// ---------------------------------------------------------------------------

export class TransitousClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(opts: TransitousClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent =
      opts.userAgent ?? process.env.DB_MCP_USER_AGENT ?? DEFAULT_USER_AGENT;
  }

  /** Fuzzy station search. Returns stops only, best match first. */
  async searchStations(query: string): Promise<Station[]> {
    const raw = await this.get("/api/v1/geocode", { text: query, type: "STOP" });
    if (!Array.isArray(raw)) {
      throw new ProviderError("geocode did not return a list", "transitous", "parse");
    }
    const stations: Station[] = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      if (item?.type !== "STOP") continue;
      const id = str(item.id);
      const name = str(item.name);
      const lat = num(item.lat);
      const lon = num(item.lon);
      if (id && name && lat !== undefined && lon !== undefined) {
        stations.push({ id, name, lat, lon });
      }
    }
    return stations;
  }

  /**
   * Departure board for a station. Rail only (incl. S-Bahn, U-Bahn, tram).
   * `time` is ISO 8601 and defaults to now; `limit` defaults to 30.
   */
  async getDepartures(
    stationId: string,
    opts: { time?: string; limit?: number } = {},
  ): Promise<Departure[]> {
    const params: Record<string, string> = {
      stopId: stationId,
      n: String(opts.limit ?? 30),
      // Merge platforms/duplicate stop entries of the same station.
      radius: "200",
      mode: RAIL_MODES.join(","),
    };
    if (opts.time) params.time = opts.time;
    const raw = await this.get("/api/v5/stoptimes", params);
    const list = (raw as { stopTimes?: RawStopTime[] })?.stopTimes;
    if (!Array.isArray(list)) {
      throw new ProviderError("stoptimes response has no stopTimes", "transitous", "parse");
    }
    const departures: Departure[] = [];
    for (const st of list) {
      const tripId = str(st.tripId);
      const scheduledDeparture = str(st.place?.scheduledDeparture);
      if (!tripId || !scheduledDeparture) continue;
      const predictedDeparture = str(st.place?.departure) ?? scheduledDeparture;
      departures.push({
        tripId,
        trainName: trainNameOf(st),
        headsign: str(st.headsign) ?? "",
        mode: str(st.mode) ?? "",
        scheduledDeparture,
        predictedDeparture,
        delayMinutes: delayMinutes(scheduledDeparture, predictedDeparture) ?? 0,
        track: str(st.place?.track),
        scheduledTrack: str(st.place?.scheduledTrack),
        cancelled:
          st.cancelled === true ||
          st.tripCancelled === true ||
          st.place?.cancelled === true,
        realTime: st.realTime === true,
      });
    }
    return departures;
  }

  /**
   * Find departures of a named train ("ICE 107", "RE1", "S19") at a station.
   * There is no upstream lookup by train name alone, so a station is required.
   * Throws ProviderError(not_found) when nothing on the board matches.
   */
  async findTrain(
    trainName: string,
    stationId: string,
    time?: string,
  ): Promise<Departure[]> {
    const wanted = normaliseName(trainName);
    if (!wanted) {
      throw new ProviderError("empty train name", "transitous", "not_found");
    }
    const board = await this.getDepartures(stationId, { time, limit: 120 });
    const matches = board.filter((d) => {
      const name = normaliseName(d.trainName);
      // "RE1 (26814)" should match both "RE1" and "RE1 (26814)".
      const base = normaliseName(d.trainName.replace(/\(.*\)/, ""));
      return name === wanted || base === wanted;
    });
    if (matches.length === 0) {
      throw new ProviderError(
        `No departure named "${trainName}" on the board of ${stationId}`,
        "transitous",
        "not_found",
      );
    }
    return matches;
  }

  /** Full per-stop status of one trip. */
  async getTrainStatus(tripId: string): Promise<TrainStatus> {
    const raw = await this.get("/api/v5/trip", { tripId });
    const leg = (raw as { legs?: RawLeg[] })?.legs?.[0];
    if (!leg || !leg.from || !leg.to) {
      throw new ProviderError(`trip ${tripId} has no legs`, "transitous", "not_found");
    }
    const places = [leg.from, ...(leg.intermediateStops ?? []), leg.to];
    return {
      tripId: str(leg.tripId) ?? tripId,
      name: trainNameOf(leg),
      headsign: str(leg.headsign) ?? "",
      mode: str(leg.mode) ?? "",
      realTime: leg.realTime === true,
      cancelled: leg.cancelled === true,
      stopovers: places.map(mapStopover),
      alerts: alertTexts(leg.alerts),
    };
  }

  /** Journey options between two stations, with live times per leg. */
  async planJourney(
    fromStationId: string,
    toStationId: string,
    time?: string,
  ): Promise<JourneyOption[]> {
    const params: Record<string, string> = {
      fromPlace: fromStationId,
      toPlace: toStationId,
      numItineraries: "4",
    };
    if (time) params.time = time;
    const raw = await this.get("/api/v5/plan", params);
    const itineraries = (raw as { itineraries?: Array<{ legs?: RawLeg[] }> })
      ?.itineraries;
    if (!Array.isArray(itineraries)) {
      throw new ProviderError("plan response has no itineraries", "transitous", "parse");
    }
    return itineraries.map((it) => ({
      legs: (it.legs ?? []).map((leg) => this.mapJourneyLeg(leg)),
      riskyTransfers: [],
    }));
  }

  /**
   * Trains currently moving inside a bounding box, with an interpolated
   * position and the predicted delay at their next stop. Rail only.
   */
  async getTrainsInArea(box: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  }): Promise<TrainInArea[]> {
    const now = Date.now();
    const raw = await this.get("/api/v5/map/trips", {
      zoom: "10",
      min: `${box.minLat},${box.minLon}`,
      max: `${box.maxLat},${box.maxLon}`,
      startTime: new Date(now).toISOString(),
      endTime: new Date(now + 60_000).toISOString(),
    });
    if (!Array.isArray(raw)) {
      throw new ProviderError("map/trips did not return a list", "transitous", "parse");
    }
    const byTrip = new Map<string, TrainInArea>();
    for (const seg of raw as RawMapSegment[]) {
      const mode = str(seg.mode) ?? "";
      if (!RAIL_MODE_SET.has(mode)) continue;
      const tripId = str(seg.trips?.[0]?.tripId);
      const fromLat = num(seg.from?.lat);
      const fromLon = num(seg.from?.lon);
      const toLat = num(seg.to?.lat);
      const toLon = num(seg.to?.lon);
      const dep = str(seg.departure);
      const arr = str(seg.arrival);
      if (
        !tripId ||
        fromLat === undefined ||
        fromLon === undefined ||
        toLat === undefined ||
        toLon === undefined ||
        !dep ||
        !arr
      ) {
        continue;
      }
      const depMs = Date.parse(dep);
      const arrMs = Date.parse(arr);
      // Fraction of the segment covered, clamped to [0, 1].
      const span = arrMs - depMs;
      const progress =
        span > 0 ? Math.min(1, Math.max(0, (now - depMs) / span)) : 0;
      const departureDelay = delayMinutes(str(seg.scheduledDeparture), dep) ?? 0;
      const delay = delayMinutes(str(seg.scheduledArrival), arr) ?? departureDelay;
      const gained = delay - departureDelay;
      const train: TrainInArea = {
        tripId,
        trainName: str(seg.trips?.[0]?.displayName) ?? mode,
        mode,
        fromStation: str(seg.from?.name) ?? "",
        toStation: str(seg.to?.name) ?? "",
        delayMinutes: delay,
        lat: fromLat + (toLat - fromLat) * progress,
        lon: fromLon + (toLon - fromLon) * progress,
        delayGainedOnSegmentMinutes: gained,
        likelyStuck: gained >= STUCK_MIN_GAIN_MINUTES,
        realTime: seg.realTime === true,
      };
      // A trip can appear on several segments; keep the one in progress now.
      const existing = byTrip.get(tripId);
      const inProgress = now >= depMs && now <= arrMs;
      if (!existing || inProgress) byTrip.set(tripId, train);
    }
    return [...byTrip.values()];
  }

  private mapJourneyLeg(leg: RawLeg): JourneyLeg {
    const scheduledDeparture =
      str(leg.scheduledStartTime) ?? str(leg.from?.scheduledDeparture) ?? "";
    const predictedDeparture =
      str(leg.startTime) ?? str(leg.from?.departure) ?? scheduledDeparture;
    const scheduledArrival =
      str(leg.scheduledEndTime) ?? str(leg.to?.scheduledArrival) ?? "";
    const predictedArrival =
      str(leg.endTime) ?? str(leg.to?.arrival) ?? scheduledArrival;
    return {
      trainName: trainNameOf(leg),
      mode: str(leg.mode) ?? "",
      tripId: str(leg.tripId),
      from: mapStation(leg.from),
      to: mapStation(leg.to),
      scheduledDeparture,
      predictedDeparture,
      scheduledArrival,
      predictedArrival,
      departureDelayMinutes: delayMinutes(scheduledDeparture, predictedDeparture) ?? 0,
      arrivalDelayMinutes: delayMinutes(scheduledArrival, predictedArrival) ?? 0,
      cancelled: leg.cancelled === true,
      realTime: leg.realTime === true,
    };
  }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params).toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new ProviderError(
          `transitous ${path} returned HTTP ${res.status}`,
          "transitous",
          res.status === 404 ? "not_found" : "http",
        );
      }
      try {
        return await res.json();
      } catch (err) {
        throw new ProviderError(
          `transitous ${path} returned a non-JSON body`,
          "transitous",
          "parse",
          err,
        );
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderError(
          `transitous ${path} timed out after ${this.timeoutMs}ms`,
          "transitous",
          "timeout",
        );
      }
      throw new ProviderError(
        `transitous ${path} request failed: ${(err as Error).message}`,
        "transitous",
        "http",
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
