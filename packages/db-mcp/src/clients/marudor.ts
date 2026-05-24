// High-level marudor (bahn.expert) client.
// Each method maps a tRPC procedure response to a domain type.

import type {
  OutgoingConnection,
  Station,
  Stopover,
  TrainIdentifier,
  TrainStatus,
} from "../types.js";
import { ProviderError } from "../errors.js";
import { MarudorRpc, type MarudorRpcOptions } from "./marudor-rpc.js";

// ---------------------------------------------------------------------------
// Raw shapes from stopPlace.byTerm
// ---------------------------------------------------------------------------

interface RawStopPlace {
  evaNumber?: unknown;
  name?: unknown;
  availableTransports?: string[];
  position?: { latitude?: number; longitude?: number };
  ril100?: unknown;
  stationId?: unknown;
}

// ---------------------------------------------------------------------------
// Raw shapes from journey.find
// ---------------------------------------------------------------------------

interface RawJourneyFindEntry {
  journeyId?: unknown;
  train?: {
    category?: unknown;
    journeyNumber?: unknown;
    line?: unknown;
    transportType?: unknown;
  };
  firstStop?: { stopPlace?: { name?: unknown; evaNumber?: unknown } };
  lastStop?: { stopPlace?: { name?: unknown; evaNumber?: unknown } };
}

// ---------------------------------------------------------------------------
// Raw shapes from journey.detailsByJourneyId
// ---------------------------------------------------------------------------

interface RawStopEvent {
  scheduledTime?: unknown;
  time?: unknown;
  cancelled?: unknown;
  delay?: unknown;
  scheduledPlatform?: unknown;
  platform?: unknown;
  id?: unknown;
  noPassengerChange?: unknown;
}

interface RawStop {
  stopPlace?: { evaNumber?: unknown; name?: unknown };
  arrival?: RawStopEvent;
  departure?: RawStopEvent;
}

interface RawJourneyDetails {
  stops?: RawStop[];
  journeyId?: unknown;
  train?: {
    category?: unknown;
    journeyNumber?: unknown;
    name?: unknown;
    transportType?: unknown;
  };
  finalDestination?: unknown;
  segmentStart?: { evaNumber?: unknown; name?: unknown };
  segmentDestination?: { evaNumber?: unknown; name?: unknown };
  cancelled?: unknown;
  departure?: RawStopEvent & { transport?: { journeyDescription?: unknown } };
  arrival?: RawStopEvent & { transport?: { journeyDescription?: unknown } };
}

// ---------------------------------------------------------------------------
// Raw shapes from connections.connections
// ---------------------------------------------------------------------------

interface RawPersonaStatus {
  persona?: unknown;
  status?: unknown;
  duration?: unknown;
  distance?: unknown;
}

interface RawConnection {
  canceled?: unknown;
  journeyID?: unknown;
  time?: unknown;
  timeSchedule?: unknown;
  transport?: {
    category?: unknown;
    line?: unknown;
    journeyNumber?: unknown;
    destination?: { name?: unknown; evaNumber?: unknown };
    type?: unknown;
  };
  connectionStatusByPersona?: RawPersonaStatus[];
  platform?: unknown;
  platformSchedule?: unknown;
  futureDisruptions?: unknown;
}

interface RawConnectionsResponse {
  connections?: RawConnection[];
  arrivalID?: unknown;
  arrivalTime?: unknown;
  arrivalCanceled?: unknown;
}

// ---------------------------------------------------------------------------
// Pure mapper helpers
// ---------------------------------------------------------------------------

function toStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function toNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function mapJourneyFindEntry(
  raw: RawJourneyFindEntry,
  date: string,
): TrainIdentifier | null {
  const journeyId = toStr(raw.journeyId);
  if (!journeyId) return null;

  const category = toStr(raw.train?.category) ?? "";
  const journeyNumber = toNum(raw.train?.journeyNumber);
  const name =
    category && journeyNumber
      ? `${category} ${journeyNumber}`
      : (toStr(raw.train?.line) ?? journeyId);

  const origin = toStr(raw.firstStop?.stopPlace?.name) ?? "";
  const destination = toStr(raw.lastStop?.stopPlace?.name) ?? "";

  return { journeyId, name, origin, destination, date };
}

function mapStopEvent(raw: RawStopEvent | undefined): {
  scheduledTime?: string;
  predictedTime?: string;
  delay?: number;
  platform?: string;
  platformScheduled?: string;
  cancelled: boolean;
  id?: string;
} {
  if (!raw) {
    return { cancelled: false };
  }
  return {
    scheduledTime: toStr(raw.scheduledTime),
    predictedTime: toStr(raw.time),
    delay: toNum(raw.delay),
    platform: toStr(raw.platform),
    platformScheduled: toStr(raw.scheduledPlatform),
    cancelled: raw.cancelled === true,
    id: toStr(raw.id),
  };
}

function mapStop(rawStop: RawStop): Stopover {
  const evaNumber = toStr(rawStop.stopPlace?.evaNumber) ?? "";
  const stationName = toStr(rawStop.stopPlace?.name) ?? "";

  const arr = mapStopEvent(rawStop.arrival);
  const dep = mapStopEvent(rawStop.departure);

  return {
    evaNumber,
    stationName,
    scheduledArrival: arr.scheduledTime,
    predictedArrival: arr.predictedTime,
    scheduledDeparture: dep.scheduledTime,
    predictedDeparture: dep.predictedTime,
    arrivalDelayMinutes: arr.delay,
    departureDelayMinutes: dep.delay,
    platformScheduled: dep.platformScheduled ?? arr.platformScheduled,
    platformActual: dep.platform ?? arr.platform,
    cancelled: arr.cancelled || dep.cancelled,
    outgoingConnections: [],
    messages: [],
  };
}

function mapConnection(raw: RawConnection): OutgoingConnection {
  const transport = raw.transport;
  const category = toStr(transport?.category) ?? "";
  const line = toStr(transport?.line);
  const journeyNumber = toNum(transport?.journeyNumber);
  const trainName = line
    ? `${category} ${line}`.trim()
    : category && journeyNumber
      ? `${category} ${journeyNumber}`
      : category;

  const destination = toStr(transport?.destination?.name) ?? "";

  const scheduledDeparture = toStr(raw.timeSchedule) ?? "";
  const predictedDeparture = toStr(raw.time) ?? scheduledDeparture;

  // Compute delay in minutes from ISO strings
  let delayMinutes = 0;
  try {
    const sched = new Date(scheduledDeparture).getTime();
    const pred = new Date(predictedDeparture).getTime();
    if (!Number.isNaN(sched) && !Number.isNaN(pred)) {
      delayMinutes = Math.round((pred - sched) / 60000);
    }
  } catch {
    // leave 0
  }

  // willBeHeld: true when any persona status is "CRITICAL"
  const statuses = (raw.connectionStatusByPersona ?? []).map((p) => p.status);
  const willBeHeld = statuses.some((s) => s === "CRITICAL") || undefined;

  return {
    trainName,
    destination,
    scheduledDeparture,
    predictedDeparture,
    delayMinutes,
    ...(willBeHeld !== undefined ? { willBeHeld } : {}),
  };
}

// ---------------------------------------------------------------------------
// MarudorClient
// ---------------------------------------------------------------------------

export class MarudorClient {
  private readonly rpc: MarudorRpc;

  constructor(opts?: MarudorRpcOptions) {
    this.rpc = new MarudorRpc(opts);
  }

  // -------------------------------------------------------------------------
  // searchStations — existing method, unchanged
  // -------------------------------------------------------------------------

  /**
   * Search for stations by name or partial name.
   * Procedure: stopPlace.byTerm
   * Input: { searchTerm: string }
   * Returns Station[] with evaNumber and name populated.
   */
  async searchStations(query: string): Promise<Station[]> {
    const raw = await this.rpc.query<unknown>("stopPlace.byTerm", {
      searchTerm: query,
    });

    if (!Array.isArray(raw)) {
      return [];
    }

    const stations: Station[] = [];
    for (const item of raw as RawStopPlace[]) {
      const evaNumber =
        typeof item.evaNumber === "string" ? item.evaNumber : undefined;
      const name = typeof item.name === "string" ? item.name : undefined;
      if (evaNumber && name) {
        stations.push({ evaNumber, name });
      }
    }
    return stations;
  }

  // -------------------------------------------------------------------------
  // findJourney — step 1: find candidate journey IDs
  // -------------------------------------------------------------------------

  /**
   * Find candidate journey IDs for a given train name and date.
   * trainName: "ICE 597" or just "597" — category prefix is split off if present.
   * date: YYYY-MM-DD, defaults to today (UTC).
   * Throws ProviderError("not_found") if the API returns an empty array.
   */
  async findJourney(
    trainName: string,
    date?: string,
  ): Promise<TrainIdentifier[]> {
    // Parse trainName: "ICE 597" → category="ICE", number=597; "597" → number=597
    const parts = trainName.trim().split(/\s+/);
    let category: string | undefined;
    let journeyNumber: number;

    if (parts.length >= 2 && Number.isNaN(Number(parts[0]))) {
      // First token is non-numeric → treat as category
      category = parts[0].toUpperCase();
      journeyNumber = parseInt(parts.slice(1).join(""), 10);
    } else {
      journeyNumber = parseInt(parts[0], 10);
    }

    if (Number.isNaN(journeyNumber)) {
      throw new ProviderError(
        `Cannot parse train number from "${trainName}"`,
        "marudor",
        "not_found",
      );
    }

    // Date defaults to today UTC
    const useDate = date ?? new Date().toISOString().slice(0, 10);
    const dateObj = new Date(`${useDate}T00:00:00.000Z`);

    const input: Record<string, unknown> = {
      journeyNumber,
      date: dateObj,
    };
    if (category) input.category = category;

    const raw = await this.rpc.query<unknown>("journey.find", input);

    if (!Array.isArray(raw)) {
      throw new ProviderError(
        `Unexpected response shape from journey.find for "${trainName}"`,
        "marudor",
        "parse",
      );
    }

    if (raw.length === 0) {
      throw new ProviderError(
        `Train not found: "${trainName}" on ${useDate}`,
        "marudor",
        "not_found",
      );
    }

    const results: TrainIdentifier[] = [];
    for (const entry of raw as RawJourneyFindEntry[]) {
      const mapped = mapJourneyFindEntry(entry, useDate);
      if (mapped) results.push(mapped);
    }

    if (results.length === 0) {
      throw new ProviderError(
        `No valid journey IDs found for "${trainName}" on ${useDate}`,
        "marudor",
        "not_found",
      );
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // getJourneyDetails — step 2: full stop-by-stop timeline
  // -------------------------------------------------------------------------

  /**
   * Fetch the full stop-by-stop timeline for a journey.
   * Procedure: journey.detailsByJourneyId
   */
  async getJourneyDetails(journeyId: string): Promise<TrainStatus> {
    const raw = await this._fetchDetailsRaw(journeyId);
    return this._mapDetailsToTrainStatus(raw, journeyId);
  }

  private async _fetchDetailsRaw(journeyId: string): Promise<RawJourneyDetails> {
    const raw = await this.rpc.query<unknown>(
      "journey.detailsByJourneyId",
      journeyId,
    );
    return raw as RawJourneyDetails;
  }

  private _mapDetailsToTrainStatus(
    details: RawJourneyDetails,
    fallbackJourneyId: string,
  ): TrainStatus {
    const trainName =
      toStr(details.train?.name) ??
      (() => {
        const cat = toStr(details.train?.category) ?? "";
        const num = toNum(details.train?.journeyNumber);
        return num ? `${cat} ${num}` : cat;
      })();

    const origin =
      toStr(details.segmentStart?.name) ??
      toStr(details.departure?.transport?.journeyDescription) ??
      "";

    const destination =
      toStr(details.finalDestination) ??
      toStr(details.segmentDestination?.name) ??
      "";

    // Derive date from first stop's scheduled departure/arrival, or top-level departure
    let dateStr = "";
    const firstDepTime =
      toStr(details.departure?.scheduledTime) ??
      toStr(details.stops?.[0]?.departure?.scheduledTime) ??
      toStr(details.stops?.[0]?.arrival?.scheduledTime);
    if (firstDepTime) {
      dateStr = firstDepTime.slice(0, 10);
    }

    const identifier: TrainIdentifier = {
      journeyId: toStr(details.journeyId) ?? fallbackJourneyId,
      name: trainName,
      origin,
      destination,
      date: dateStr,
    };

    const stopovers: Stopover[] = (details.stops ?? []).map(mapStop);

    return {
      identifier,
      stopovers,
      messages: [],
      cancelled: details.cancelled === true,
    };
  }

  // -------------------------------------------------------------------------
  // getConnections — step 3: outgoing connections at one stop
  // -------------------------------------------------------------------------

  /**
   * Fetch outgoing connections at a single stop along a journey.
   * Procedure: connections.connections
   */
  async getConnections(
    journeyId: string,
    arrivalId: string,
    evaNumber: string,
  ): Promise<OutgoingConnection[]> {
    const raw = await this.rpc.query<unknown>("connections.connections", {
      journeyId,
      arrivalId,
      evaNumber,
    });

    const resp = raw as RawConnectionsResponse;
    const connections = resp.connections ?? [];
    return connections.map(mapConnection);
  }

  // -------------------------------------------------------------------------
  // getTrainStatus — orchestrator
  // -------------------------------------------------------------------------

  /**
   * Find a train by name + date, fetch its full timeline, then in parallel
   * fetch outgoing connections for every stop that has an arrivalId.
   * Partial connection failures are swallowed (logged to stderr) rather than
   * propagated — partial data beats no data.
   */
  async getTrainStatus(trainName: string, date?: string): Promise<TrainStatus> {
    // Step 1: find journey candidates, pick the first
    const candidates = await this.findJourney(trainName, date);
    const { journeyId } = candidates[0];

    // Step 2: fetch full timeline ONCE and reuse the raw response for both
    // the TrainStatus mapping and the per-stop arrival ID extraction below.
    const rawDetails = await this._fetchDetailsRaw(journeyId);
    const status = this._mapDetailsToTrainStatus(rawDetails, journeyId);

    const rawStops: RawStop[] = rawDetails.stops ?? [];

    const connectionResults = await Promise.allSettled(
      rawStops.map(async (rawStop, idx) => {
        const arrivalId = toStr(rawStop.arrival?.id);
        const evaNumber = toStr(rawStop.stopPlace?.evaNumber);

        if (!arrivalId || !evaNumber) {
          // No arrival ID (origin stop) — skip
          return { idx, connections: [] as OutgoingConnection[] };
        }

        try {
          const conns = await this.getConnections(journeyId, arrivalId, evaNumber);
          return { idx, connections: conns };
        } catch (err) {
          process.stderr.write(
            `[db-mcp] getConnections failed for stop ${evaNumber} (${arrivalId}): ${String(err)}\n`,
          );
          return { idx, connections: [] as OutgoingConnection[] };
        }
      }),
    );

    // Populate outgoingConnections on each stopover
    for (const result of connectionResults) {
      if (result.status === "fulfilled") {
        const { idx, connections } = result.value;
        if (status.stopovers[idx]) {
          status.stopovers[idx].outgoingConnections = connections;
        }
      } else {
        // Promise.allSettled should not reject because we catch inside, but handle defensively
        process.stderr.write(
          `[db-mcp] Unexpected rejection in getTrainStatus connection step: ${String(result.reason)}\n`,
        );
      }
    }

    return status;
  }
}
