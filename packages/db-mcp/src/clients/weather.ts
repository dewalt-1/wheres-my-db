import { ProviderError } from "../errors.js";
import type { WeatherWarning } from "../types.js";

const DEFAULT_BASE_URL = "https://www.dwd.de";
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_RADIUS_KM = 25;
const JSONP_PREFIX = "warnWetter.loadWarnings(";
const JSONP_SUFFIX = ");";

export interface StationCoordinates {
  lat: number;
  lon: number;
  name: string;
}

export type StationResolver = (
  evaNumber: string,
) => Promise<StationCoordinates>;

export interface WeatherClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  stationResolver: StationResolver;
  radiusKm?: number;
}

interface RawWarning {
  regionName?: unknown;
  level?: unknown;
  start?: unknown;
  end?: unknown;
  event?: unknown;
  headline?: unknown;
  description?: unknown;
}

interface RawDwdResponse {
  time?: unknown;
  warnings?: Record<string, RawWarning[]>;
}

export class WeatherClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly resolveStation: StationResolver;
  // radiusKm reserved for Task 4 filtering.
  private readonly radiusKm: number;

  constructor(opts: WeatherClientOptions) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.resolveStation = opts.stationResolver;
    this.radiusKm = opts.radiusKm ?? DEFAULT_RADIUS_KM;
  }

  async getWarningsForStation(
    evaNumber: string,
    _atTime?: string,
  ): Promise<{
    stationCoordinates: StationCoordinates;
    warnings: WeatherWarning[];
  }> {
    const stationCoordinates = await this.resolveStation(evaNumber);
    const parsed = await this.fetchAndParse();
    const allWarnings: WeatherWarning[] = [];
    const buckets = parsed.warnings ?? {};
    for (const list of Object.values(buckets)) {
      for (const raw of list) {
        const mapped = this.mapWarning(raw);
        if (mapped) allWarnings.push(mapped);
      }
    }
    // Filtering is added in Task 4. Task 3 returns everything mapped.
    return { stationCoordinates, warnings: allWarnings };
  }

  private mapWarning(raw: RawWarning): WeatherWarning | null {
    const event = typeof raw.event === "string" ? raw.event : undefined;
    const level = raw.level;
    const start = typeof raw.start === "number" ? raw.start : undefined;
    const end = typeof raw.end === "number" ? raw.end : undefined;
    const headline = typeof raw.headline === "string" ? raw.headline : "";
    const description =
      typeof raw.description === "string" ? raw.description : "";
    const areaName = typeof raw.regionName === "string" ? raw.regionName : "";

    if (!event || start === undefined || end === undefined) return null;
    if (level !== 1 && level !== 2 && level !== 3 && level !== 4) return null;

    return {
      type: event,
      level: level,
      headline,
      description,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      areaName,
    };
  }

  private async fetchAndParse(): Promise<RawDwdResponse> {
    const url = `${this.baseUrl}/DWD/warnungen/warnapp/json/warnings.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let body: string;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new ProviderError(
          `dwd GET ${url} returned ${res.status}`,
          "dwd",
          "http",
        );
      }
      body = await res.text();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderError(
          `dwd timeout after ${this.timeoutMs}ms`,
          "dwd",
          "timeout",
        );
      }
      throw new ProviderError(
        `dwd request failed: ${(err as Error).message}`,
        "dwd",
        "http",
        err,
      );
    } finally {
      clearTimeout(timer);
    }
    return this.parseBody(body);
  }

  private parseBody(body: string): RawDwdResponse {
    let inner = body.trim();
    if (inner.startsWith(JSONP_PREFIX)) {
      inner = inner.slice(JSONP_PREFIX.length);
      if (inner.endsWith(JSONP_SUFFIX)) {
        inner = inner.slice(0, -JSONP_SUFFIX.length);
      }
    }
    try {
      return JSON.parse(inner) as RawDwdResponse;
    } catch (err) {
      throw new ProviderError(
        "dwd returned unparseable body",
        "dwd",
        "parse",
        err,
      );
    }
  }
}
