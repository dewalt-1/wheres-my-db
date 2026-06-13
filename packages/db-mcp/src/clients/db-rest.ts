// Plain-REST public DB API client (db-rest).
// Fallback when marudor's tRPC fails. Maps REST responses to domain types.

import type {
  Disruption,
  JourneyLeg,
  JourneyOption,
  Station,
} from "../types.js";
import { ProviderError } from "../errors.js";

export interface DbRestClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class DbRestClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts?: DbRestClientOptions) {
    this.baseUrl = opts?.baseUrl ?? "https://v6.db.transport.rest";
    this.timeoutMs = opts?.timeoutMs ?? 4000;
  }

  async searchStations(query: string): Promise<Station[]> {
    const url = `${this.baseUrl}/locations?query=${encodeURIComponent(query)}&results=5`;
    const raw = await this.fetchJson<RawLocation[]>(url);

    return raw
      .filter((loc) => loc.type === "station" || loc.type === "stop")
      .map((loc) => ({
        evaNumber: String(loc.id),
        name: String(loc.name),
      }));
  }

  async searchJourneys(
    fromEva: string,
    toEva: string,
    isoTime?: string,
  ): Promise<JourneyOption[]> {
    const params = new URLSearchParams({
      from: fromEva,
      to: toEva,
      results: "3",
    });
    if (isoTime) {
      params.append("departure", isoTime);
    }

    const url = `${this.baseUrl}/journeys?${params.toString()}`;
    const raw = await this.fetchJson<RawJourneysResponse>(url);

    return raw.journeys.map((journey) => ({
      legs: journey.legs
        .filter((leg) => !leg.walking)
        .map((leg) => this.mapLeg(leg)),
      riskyTransfers: [],
    }));
  }

  async getTrainDetails(): Promise<never> {
    throw new ProviderError(
      "db-rest does not support train name lookup",
      "db-rest",
      "not_found",
    );
  }

  async getDisruptions(): Promise<Disruption[]> {
    return [];
  }

  private mapLeg(leg: RawLeg): JourneyLeg {
    const departureDelay = typeof leg.departureDelay === "number"
      ? Math.round(leg.departureDelay / 60)
      : 0;
    const arrivalDelay = typeof leg.arrivalDelay === "number"
      ? Math.round(leg.arrivalDelay / 60)
      : 0;

    return {
      trainName: String(leg.line.name),
      from: {
        evaNumber: String(leg.origin.id),
        name: String(leg.origin.name),
      },
      to: {
        evaNumber: String(leg.destination.id),
        name: String(leg.destination.name),
      },
      scheduledDeparture: String(leg.plannedDeparture),
      predictedDeparture: String(leg.departure ?? leg.plannedDeparture),
      scheduledArrival: String(leg.plannedArrival),
      predictedArrival: String(leg.arrival ?? leg.plannedArrival),
      departureDelayMinutes: departureDelay,
      arrivalDelayMinutes: arrivalDelay,
    };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        throw new ProviderError(
          `HTTP ${response.status}`,
          "db-rest",
          "http",
        );
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ProviderError(
          "Failed to parse response body",
          "db-rest",
          "parse",
        );
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderError(
          "Request timeout",
          "db-rest",
          "timeout",
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Raw shapes from db-rest API
// ---------------------------------------------------------------------------

interface RawLocation {
  type: string;
  id: unknown;
  name: unknown;
}

interface RawLine {
  name: unknown;
}

interface RawStopPlace {
  id: unknown;
  name: unknown;
}

interface RawLeg {
  line: RawLine;
  origin: RawStopPlace;
  destination: RawStopPlace;
  plannedDeparture: unknown;
  departure?: unknown;
  plannedArrival: unknown;
  arrival?: unknown;
  departureDelay?: unknown;
  arrivalDelay?: unknown;
  walking?: boolean;
}

interface RawJourney {
  legs: RawLeg[];
}

interface RawJourneysResponse {
  journeys: RawJourney[];
}
