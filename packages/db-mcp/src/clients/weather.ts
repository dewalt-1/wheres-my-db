// Client for DWD (Deutscher Wetterdienst) weather warnings.
//
// Uses DWD's public map service (GeoServer WFS), layer
// dwd:Warnungen_Landkreise, which holds every current and upcoming official
// warning together with the district polygon it applies to. We ask the
// server for the warnings whose polygon contains a point, so the answer is
// exact for that location and small (no nationwide download).

import { ProviderError } from "../errors.js";
import type { WeatherWarning } from "../types.js";

const DEFAULT_BASE_URL = "https://maps.dwd.de";
// Point queries take 0.1s when nothing matches and up to ~6s when they do.
const DEFAULT_TIMEOUT_MS = 20000;

const SEVERITY_LEVEL: Record<string, 1 | 2 | 3 | 4> = {
  Minor: 1,
  Moderate: 2,
  Severe: 3,
  Extreme: 4,
};

export interface WeatherClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

interface RawFeature {
  properties?: {
    EVENT?: unknown;
    SEVERITY?: unknown;
    HEADLINE?: unknown;
    DESCRIPTION?: unknown;
    ONSET?: unknown;
    EXPIRES?: unknown;
    AREADESC?: unknown;
  };
}

function mapFeature(feature: RawFeature): WeatherWarning | null {
  const p = feature.properties ?? {};
  const type = typeof p.EVENT === "string" ? p.EVENT : undefined;
  const level = typeof p.SEVERITY === "string" ? SEVERITY_LEVEL[p.SEVERITY] : undefined;
  const start = typeof p.ONSET === "string" ? Date.parse(p.ONSET) : NaN;
  const end = typeof p.EXPIRES === "string" ? Date.parse(p.EXPIRES) : NaN;
  if (!type || !level || Number.isNaN(start) || Number.isNaN(end)) return null;
  return {
    type,
    level,
    headline: typeof p.HEADLINE === "string" ? p.HEADLINE : "",
    description: typeof p.DESCRIPTION === "string" ? p.DESCRIPTION : "",
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    areaName: typeof p.AREADESC === "string" ? p.AREADESC : "",
  };
}

export class WeatherClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: WeatherClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Official warnings for the district containing `point`.
   * Without `atTime`: every warning that has not expired yet, including ones
   * that start later today or tomorrow (check `start`).
   * With `atTime` (ISO 8601): only warnings in force at that moment.
   */
  async getWarningsNear(
    point: { lat: number; lon: number },
    atTime?: string,
  ): Promise<{ warnings: WeatherWarning[] }> {
    const params = new URLSearchParams({
      service: "WFS",
      // 1.0.0 takes coordinates as "lon lat"; 2.0.0 swaps the order.
      version: "1.0.0",
      request: "GetFeature",
      typeName: "dwd:Warnungen_Landkreise",
      outputFormat: "application/json",
      CQL_FILTER: `INTERSECTS(THE_GEOM, POINT(${point.lon} ${point.lat}))`,
    });
    const body = await this.fetchJson(`${this.baseUrl}/geoserver/dwd/ows?${params.toString()}`);
    const features = (body as { features?: RawFeature[] })?.features;
    if (!Array.isArray(features)) {
      throw new ProviderError("dwd response has no features list", "dwd", "parse");
    }

    const now = Date.now();
    const at = atTime ? Date.parse(atTime) : undefined;
    const warnings: WeatherWarning[] = [];
    for (const feature of features) {
      const warning = mapFeature(feature);
      if (!warning) continue;
      const start = Date.parse(warning.start);
      const end = Date.parse(warning.end);
      if (at !== undefined && !Number.isNaN(at)) {
        if (at < start || at > end) continue;
      } else if (end < now) {
        continue;
      }
      warnings.push(warning);
    }
    return { warnings };
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new ProviderError(`dwd returned HTTP ${res.status}`, "dwd", "http");
      }
      try {
        return await res.json();
      } catch (err) {
        throw new ProviderError("dwd returned a non-JSON body", "dwd", "parse", err);
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderError(`dwd timed out after ${this.timeoutMs}ms`, "dwd", "timeout");
      }
      throw new ProviderError(`dwd request failed: ${(err as Error).message}`, "dwd", "http", err);
    } finally {
      clearTimeout(timer);
    }
  }
}
