// Provider router: transparent fallback from marudor to db-rest.
// For each method, tries primary first. On ProviderError, attempts fallback.
// Returns SourcedResponse with data, source ("marudor" | "db-rest"), and
// degraded flag (true when fallback was used).

import type {
  SourcedResponse,
  Station,
  TrainStatus,
  JourneyOption,
  Disruption,
} from "../types.js";
import { ProviderError, AllProvidersFailedError } from "../errors.js";

/**
 * ProviderRouter: wraps two clients (marudor primary, db-rest fallback).
 * For each method, tries primary first. On ProviderError, retries with fallback.
 * Non-ProviderError exceptions are propagated unchanged (programmer error).
 */
export class ProviderRouter {
  constructor(
    private readonly primary: Pick<
      any,
      "searchStations" | "getTrainStatus" | "searchJourneys" | "getDisruptions"
    >,
    private readonly fallback: Pick<
      any,
      "searchStations" | "getTrainDetails" | "searchJourneys" | "getDisruptions"
    >,
  ) {}

  /**
   * Try primary, then fallback on ProviderError.
   * Non-ProviderError exceptions bubble.
   * Returns { data, source, degraded }.
   * Throws AllProvidersFailedError if both fail.
   */
  private async race<T>(
    primaryFn: () => Promise<T>,
    fallbackFn: () => Promise<T>,
  ): Promise<{ data: T; source: "marudor" | "db-rest"; degraded: boolean }> {
    const errors: ProviderError[] = [];

    // Try primary
    try {
      const data = await primaryFn();
      return { data, source: "marudor", degraded: false };
    } catch (err) {
      // If not ProviderError, propagate
      if (!(err instanceof ProviderError)) {
        throw err;
      }
      errors.push(err);
    }

    // Primary failed with ProviderError, try fallback
    try {
      const data = await fallbackFn();
      return { data, source: "db-rest", degraded: true };
    } catch (err) {
      // If not ProviderError, propagate
      if (!(err instanceof ProviderError)) {
        throw err;
      }
      errors.push(err);
    }

    // Both failed with ProviderError
    throw new AllProvidersFailedError(errors);
  }

  async searchStations(query: string): Promise<SourcedResponse<Station[]>> {
    return this.race(
      () => this.primary.searchStations(query),
      () => this.fallback.searchStations(query),
    );
  }

  async getTrainStatus(
    trainName: string,
    date?: string,
  ): Promise<SourcedResponse<TrainStatus>> {
    return this.race(
      () => this.primary.getTrainStatus(trainName, date),
      () => this.fallback.getTrainDetails(trainName),
    );
  }

  async searchJourneys(
    fromEva: string,
    toEva: string,
    isoTime?: string,
  ): Promise<SourcedResponse<JourneyOption[]>> {
    return this.race(
      () => this.primary.searchJourneys(fromEva, toEva, isoTime),
      () => this.fallback.searchJourneys(fromEva, toEva, isoTime),
    );
  }

  async getDisruptions(
    filter: { evaNumber?: string },
  ): Promise<SourcedResponse<Disruption[]>> {
    return this.race(
      () => this.primary.getDisruptions(filter),
      () => this.fallback.getDisruptions(filter),
    );
  }
}
