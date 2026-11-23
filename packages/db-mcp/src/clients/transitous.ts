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
const DEFAULT_USER_AGENT =
  "wheres-my-db/0.2 (+https://github.com/dewalt-1/wheres-my-db)";

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

const LONG_DISTANCE_MODES = ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"] as const;
/** Train names that only ever run as long-distance trains. */
const LONG_DISTANCE_NAME = /^(ICE|ECE|EC|IC|EN|NJ|RJX|RJ|TGV|FLX|THA|EST|ES)\s*\d/i;

/** A train losing at least this much time between two stops is flagged likelyStuck. */
const STUCK_MIN_GAIN_MINUTES = 10;
/** A segment scheduled longer than this skips stops. */
const MAX_STOP_TO_STOP_MINUTES = 60;
const FEEDS_DISAGREE_MINUTES = 10;
/** Two feeds' timetables for one train differ by at most this much. */
const SAME_TRAIN_MINUTES = 3;

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

/**
 * Run number without category or leading zeros: "ICE 107" → "107",
 * "026814" → "26814", "RE1 (26814)" → "26814".
 */
function trainNumberOf(raw: { tripShortName?: unknown; displayName?: unknown }): string | undefined {
  const fromShort = str(raw.tripShortName)?.match(/(\d+)\s*$/)?.[1];
  const fromDisplay = str(raw.displayName)?.match(/\((\d+)\)|(\d+)\s*$/);
  const digits = fromShort ?? fromDisplay?.[1] ?? fromDisplay?.[2];
  return digits ? digits.replace(/^0+(?=\d)/, "") : undefined;
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

/**
 * Trip ids look like "20261117_16:38_nl-OpenOV_394269312": service day and
 * start time first, then the feed. The same run from two feeds shares that
 * start, wherever each feed currently places the train.
 */
function runStart(tripId: string): string | undefined {
  return /^\d{8}_\d{2}:\d{2}/.exec(tripId)?.[0];
}

/** The feed a trip id comes from, e.g. "de-DELFI" or "nl-OpenOV". */
function feedOf(tripId: string): string {
  return /^\d{8}_\d{2}:\d{2}_([^_]+)/.exec(tripId)?.[1] ?? "";
}

/**
 * Which record of a train to trust: live data first, then the German source,
 * then other countries'. A foreign feed often has no delays for German stops
 * and shows them "on time", so it is only the fallback.
 */
function betterRecord(a: { tripId: string; realTime: boolean }, b: { tripId: string; realTime: boolean }): boolean {
  if (a.realTime !== b.realTime) return a.realTime;
  return feedOf(a.tripId).startsWith("de-") && !feedOf(b.tripId).startsWith("de-");
}

/** "ICE 124" is one train a day; "S12" is many, so a shared name proves nothing. */
function isNumberedTrain(name: string): boolean {
  return LONG_DISTANCE_NAME.test(name.trim());
}

function baseName(name: string): string {
  return normaliseName(name.replace(/\(.*\)/, ""));
}

/**
 * Two board entries that are the same train from two feeds. Only ever across
 * feeds: one feed listing a line twice in a minute means two trains (both
 * directions of the S12). Feeds' timetables can differ by a minute or two.
 */
function sameDeparture(a: Departure, b: Departure): boolean {
  if (feedOf(a.tripId) === feedOf(b.tripId) || baseName(a.trainName) !== baseName(b.trainName)) return false;
  const apart = Math.abs(Date.parse(a.scheduledDeparture) - Date.parse(b.scheduledDeparture));
  if (apart > SAME_TRAIN_MINUTES * 60_000) return false;
  if (isNumberedTrain(a.trainName)) return true;
  return runStart(a.tripId) === runStart(b.tripId) && normaliseName(a.headsign) === normaliseName(b.headsign);
}

/** The same train in the area list: see sameDeparture. */
function sameTrainInArea(a: TrainInArea, b: TrainInArea): boolean {
  if (baseName(a.trainName) !== baseName(b.trainName)) return false;
  const close = (x: number, y: number) => Math.abs(x - y) < 0.01;
  const sameSegment =
    close(a.fromLat, b.fromLat) && close(a.fromLon, b.fromLon) && close(a.toLat, b.toLat) && close(a.toLon, b.toLon);
  if (feedOf(a.tripId) === feedOf(b.tripId)) {
    // One feed listing a train twice: identical segment and times.
    return sameSegment && a.predictedDeparture === b.predictedDeparture && a.predictedArrival === b.predictedArrival;
  }
  if (runStart(a.tripId) === undefined || runStart(a.tripId) !== runStart(b.tripId)) return false;
  return isNumberedTrain(a.trainName) || sameSegment;
}

/** Keep one record per train, the one to trust most, in the original order. */
function onePerTrain<T extends { tripId: string; realTime: boolean }>(
  items: T[],
  same: (a: T, b: T) => boolean,
  onMerge?: (kept: T, dropped: T) => void,
): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const i = kept.findIndex((k) => same(k, item));
    if (i === -1) {
      kept.push(item);
      continue;
    }
    const [winner, loser] = betterRecord(item, kept[i]) ? [item, kept[i]] : [kept[i], item];
    onMerge?.(winner, loser);
    kept[i] = winner;
  }
  return kept;
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
  private readonly countries = new Map<string, string | undefined>();

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
    opts: { time?: string; limit?: number; windowSeconds?: number; modes?: readonly string[] } = {},
  ): Promise<Departure[]> {
    const params: Record<string, string> = {
      stopId: stationId,
      n: String(opts.limit ?? 30),
      // Merge platforms/duplicate stop entries of the same station.
      radius: "200",
      mode: (opts.modes ?? RAIL_MODES).join(","),
    };
    if (opts.time) params.time = opts.time;
    // With a window the board covers that whole span, however many entries it takes.
    if (opts.windowSeconds) params.window = String(opts.windowSeconds);
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
    return onePerTrain(departures, sameDeparture);
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
    // The board is sorted by actual departure, so a late train sits far down
    // it. Search a time window rather than a number of entries, starting
    // before the requested time in case the user is on board already.
    // Long-distance names: only long-distance trains, 3 h either side.
    // Others (S-Bahn, tram lines run often): all rail, 1 h before to 2 h after.
    const longDistance = LONG_DISTANCE_NAME.test(trainName.trim());
    const hoursBefore = longDistance ? 3 : 1;
    const from = new Date(Date.parse(time ?? new Date().toISOString()) - hoursBefore * 3600_000);
    const board = await this.getDepartures(stationId, {
      time: from.toISOString(),
      windowSeconds: (longDistance ? 6 : 3) * 3600,
      modes: longDistance ? LONG_DISTANCE_MODES : RAIL_MODES,
    });
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

  /**
   * ISO country code ("DE", "NL") of the stop at a point, via reverse
   * geocoding. Stations don't move, so answers are kept for the session.
   */
  async countryAt(lat: number, lon: number): Promise<string | undefined> {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (this.countries.has(key)) return this.countries.get(key);
    const raw = await this.get("/api/v1/reverse-geocode", { place: `${lat},${lon}`, type: "STOP" });
    const country = str((raw as Array<{ country?: unknown }>)?.[0]?.country)?.toUpperCase();
    this.countries.set(key, country);
    return country;
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
      trainNumber: trainNumberOf(leg),
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
      // A segment scheduled at over an hour skips stops (cancelled ones, as in
      // a diversion). Time lost there is the detour, not a train standing still.
      const scheduledMinutes =
        (Date.parse(str(seg.scheduledArrival) ?? arr) - Date.parse(str(seg.scheduledDeparture) ?? dep)) / 60_000;
      const skipsStops = scheduledMinutes > MAX_STOP_TO_STOP_MINUTES;
      const train: TrainInArea = {
        tripId,
        trainName: str(seg.trips?.[0]?.displayName) ?? mode,
        mode,
        fromStation: str(seg.from?.name) ?? "",
        toStation: str(seg.to?.name) ?? "",
        fromLat,
        fromLon,
        toLat,
        toLon,
        predictedDeparture: dep,
        predictedArrival: arr,
        delayMinutes: delay,
        lat: fromLat + (toLat - fromLat) * progress,
        lon: fromLon + (toLon - fromLon) * progress,
        progress,
        delayGainedOnSegmentMinutes: gained,
        likelyStuck: gained >= STUCK_MIN_GAIN_MINUTES && !skipsStops,
        realTime: seg.realTime === true,
      };
      // A trip can appear on several segments; keep the one in progress now.
      const existing = byTrip.get(tripId);
      const inProgress = now >= depMs && now <= arrMs;
      if (!existing || inProgress) byTrip.set(tripId, train);
    }
    return onePerTrain([...byTrip.values()], sameTrainInArea, (kept, dropped) => {
      const differ =
        Math.abs(kept.delayMinutes - dropped.delayMinutes) >= FEEDS_DISAGREE_MINUTES ||
        Math.abs(kept.fromLat - dropped.fromLat) > 0.01 || Math.abs(kept.fromLon - dropped.fromLon) > 0.01;
      // Say so, so nobody states either as fact.
      if (dropped.feedsDisagree || (kept.realTime && dropped.realTime && differ)) kept.feedsDisagree = true;
    });
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
