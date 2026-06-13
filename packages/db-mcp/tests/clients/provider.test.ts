import { describe, it, expect, vi } from "vitest";
import { ProviderRouter } from "../../src/clients/provider.js";
import { ProviderError, AllProvidersFailedError } from "../../src/errors.js";
import type {
  Station,
  TrainStatus,
  JourneyOption,
  Disruption,
} from "../../src/types.js";

// Mock data factories
function createStation(evaNumber: string, name: string): Station {
  return { evaNumber, name };
}

function createTrainStatus(trainName: string): TrainStatus {
  return {
    identifier: {
      journeyId: "j123",
      name: trainName,
      origin: "Berlin",
      destination: "Munich",
      date: "2025-06-13",
    },
    stopovers: [],
    messages: [],
    cancelled: false,
  };
}

function createJourneyOption(): JourneyOption {
  return {
    legs: [],
    riskyTransfers: [],
  };
}

function createDisruption(id: string): Disruption {
  return {
    id,
    headline: "Test disruption",
    description: "Test",
    severity: "low",
    affectedSegments: [],
  };
}

// ============================================================================
// searchStations tests
// ============================================================================

describe("ProviderRouter.searchStations", () => {
  it("primary succeeds → returns marudor source with degraded=false", async () => {
    const stations = [createStation("8000207", "Berlin Hbf")];
    const primary = vi.fn().mockResolvedValue(stations);
    const fallback = vi.fn();

    const router = new ProviderRouter({ searchStations: primary }, { searchStations: fallback });
    const result = await router.searchStations("Berlin");

    expect(primary).toHaveBeenCalledWith("Berlin");
    expect(fallback).not.toHaveBeenCalled();
    expect(result.data).toEqual(stations);
    expect(result.source).toBe("marudor");
    expect(result.degraded).toBe(false);
  });

  it("primary fails with ProviderError → fallback called → db-rest source with degraded=true", async () => {
    const stations = [createStation("8000207", "Berlin Hbf")];
    const error = new ProviderError("primary failed", "marudor", "timeout");
    const primary = vi.fn().mockRejectedValue(error);
    const fallback = vi.fn().mockResolvedValue(stations);

    const router = new ProviderRouter({ searchStations: primary }, { searchStations: fallback });
    const result = await router.searchStations("Berlin");

    expect(primary).toHaveBeenCalledWith("Berlin");
    expect(fallback).toHaveBeenCalledWith("Berlin");
    expect(result.data).toEqual(stations);
    expect(result.source).toBe("db-rest");
    expect(result.degraded).toBe(true);
  });

  it("both fail with ProviderError → throws AllProvidersFailedError", async () => {
    const primaryError = new ProviderError("primary failed", "marudor", "timeout");
    const fallbackError = new ProviderError("fallback failed", "db-rest", "http");
    const primary = vi.fn().mockRejectedValue(primaryError);
    const fallback = vi.fn().mockRejectedValue(fallbackError);

    const router = new ProviderRouter({ searchStations: primary }, { searchStations: fallback });

    await expect(router.searchStations("Berlin")).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof AllProvidersFailedError)) return false;
      expect(err.errors).toHaveLength(2);
      expect(err.errors[0]).toBe(primaryError);
      expect(err.errors[1]).toBe(fallbackError);
      return true;
    });
  });

  it("primary throws non-ProviderError → bubbles unchanged", async () => {
    const customError = new Error("custom error");
    const primary = vi.fn().mockRejectedValue(customError);
    const fallback = vi.fn();

    const router = new ProviderRouter({ searchStations: primary }, { searchStations: fallback });

    await expect(router.searchStations("Berlin")).rejects.toBe(customError);
    expect(fallback).not.toHaveBeenCalled();
  });
});

// ============================================================================
// getTrainStatus tests
// ============================================================================

describe("ProviderRouter.getTrainStatus", () => {
  it("primary succeeds → calls primary.getTrainStatus with correct args → marudor source", async () => {
    const status = createTrainStatus("ICE 597");
    const primary = vi.fn().mockResolvedValue(status);
    const fallback = vi.fn();

    const router = new ProviderRouter(
      { getTrainStatus: primary },
      { getTrainDetails: fallback },
    );
    const result = await router.getTrainStatus("ICE 597", "2025-06-13");

    expect(primary).toHaveBeenCalledWith("ICE 597", "2025-06-13");
    expect(fallback).not.toHaveBeenCalled();
    expect(result.data).toEqual(status);
    expect(result.source).toBe("marudor");
    expect(result.degraded).toBe(false);
  });

  it("primary fails → calls fallback.getTrainDetails with trainName only (note: different method)", async () => {
    const status = createTrainStatus("ICE 597");
    const primaryError = new ProviderError("not found", "marudor", "not_found");
    const primary = vi.fn().mockRejectedValue(primaryError);
    const fallback = vi.fn().mockResolvedValue(status);

    const router = new ProviderRouter(
      { getTrainStatus: primary },
      { getTrainDetails: fallback },
    );
    const result = await router.getTrainStatus("ICE 597", "2025-06-13");

    expect(primary).toHaveBeenCalledWith("ICE 597", "2025-06-13");
    // Fallback is called with trainName only (no date param)
    expect(fallback).toHaveBeenCalledWith("ICE 597");
    expect(result.data).toEqual(status);
    expect(result.source).toBe("db-rest");
    expect(result.degraded).toBe(true);
  });

  it("getTrainStatus without date param → passes undefined to primary", async () => {
    const status = createTrainStatus("ICE 597");
    const primary = vi.fn().mockResolvedValue(status);
    const fallback = vi.fn();

    const router = new ProviderRouter(
      { getTrainStatus: primary },
      { getTrainDetails: fallback },
    );
    const result = await router.getTrainStatus("ICE 597");

    expect(primary).toHaveBeenCalledWith("ICE 597", undefined);
    expect(result.source).toBe("marudor");
  });
});

// ============================================================================
// searchJourneys tests
// ============================================================================

describe("ProviderRouter.searchJourneys", () => {
  it("primary succeeds → returns marudor source with degraded=false", async () => {
    const options = [createJourneyOption()];
    const primary = vi.fn().mockResolvedValue(options);
    const fallback = vi.fn();

    const router = new ProviderRouter(
      { searchJourneys: primary },
      { searchJourneys: fallback },
    );
    const result = await router.searchJourneys("8000207", "8003409", "2025-06-13T10:00:00Z");

    expect(primary).toHaveBeenCalledWith("8000207", "8003409", "2025-06-13T10:00:00Z");
    expect(fallback).not.toHaveBeenCalled();
    expect(result.data).toEqual(options);
    expect(result.source).toBe("marudor");
    expect(result.degraded).toBe(false);
  });

  it("primary fails → fallback called → db-rest source with degraded=true", async () => {
    const options = [createJourneyOption()];
    const primaryError = new ProviderError("timeout", "marudor", "timeout");
    const primary = vi.fn().mockRejectedValue(primaryError);
    const fallback = vi.fn().mockResolvedValue(options);

    const router = new ProviderRouter(
      { searchJourneys: primary },
      { searchJourneys: fallback },
    );
    const result = await router.searchJourneys("8000207", "8003409");

    expect(primary).toHaveBeenCalledWith("8000207", "8003409", undefined);
    expect(fallback).toHaveBeenCalledWith("8000207", "8003409", undefined);
    expect(result.data).toEqual(options);
    expect(result.source).toBe("db-rest");
    expect(result.degraded).toBe(true);
  });
});

// ============================================================================
// getDisruptions tests
// ============================================================================

describe("ProviderRouter.getDisruptions", () => {
  it("primary succeeds → returns marudor source with degraded=false", async () => {
    const disruptions = [createDisruption("d1")];
    const primary = vi.fn().mockResolvedValue(disruptions);
    const fallback = vi.fn();

    const router = new ProviderRouter(
      { getDisruptions: primary },
      { getDisruptions: fallback },
    );
    const result = await router.getDisruptions({ evaNumber: "8000207" });

    expect(primary).toHaveBeenCalledWith({ evaNumber: "8000207" });
    expect(fallback).not.toHaveBeenCalled();
    expect(result.data).toEqual(disruptions);
    expect(result.source).toBe("marudor");
    expect(result.degraded).toBe(false);
  });

  it("primary fails → fallback called → db-rest source with degraded=true", async () => {
    const disruptions = [createDisruption("d1")];
    const primaryError = new ProviderError("http 500", "marudor", "http");
    const primary = vi.fn().mockRejectedValue(primaryError);
    const fallback = vi.fn().mockResolvedValue(disruptions);

    const router = new ProviderRouter(
      { getDisruptions: primary },
      { getDisruptions: fallback },
    );
    const result = await router.getDisruptions({ evaNumber: "8000207" });

    expect(primary).toHaveBeenCalledWith({ evaNumber: "8000207" });
    expect(fallback).toHaveBeenCalledWith({ evaNumber: "8000207" });
    expect(result.data).toEqual(disruptions);
    expect(result.source).toBe("db-rest");
    expect(result.degraded).toBe(true);
  });
});
