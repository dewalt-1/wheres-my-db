import { ProviderError } from "../errors.js";
import type { WeatherWarning } from "../types.js";

const DEFAULT_BASE_URL = "https://www.dwd.de";
const DEFAULT_WFS_BASE_URL = "https://maps.dwd.de";
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_RADIUS_KM = 25;
const JSONP_PREFIX = "warnWetter.loadWarnings(";
const JSONP_SUFFIX = ");";

// Coordinate filtering strategy: Option B — WFS catalog + centroid haversine.
//
// The DWD warnings.json response does NOT include per-warning coordinates. To
// resolve which warnings are near a given station we fetch the DWD WFS catalog
// (dwd:Warngebiete_Kreise) once per client instance, compute each Polygon
// centroid, then apply haversine distance from the centroid to the station.
// This is simpler than full point-in-polygon (Option A) while still being
// accurate enough for a 25 km radius threshold.

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
  wfsBaseUrl?: string;
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

// WFS catalog types — each feature carries the warncell polygon geometry.
interface WfsPolygonGeometry {
  type: "Polygon";
  coordinates: number[][][];
}

interface WfsFeatureProperties {
  WARNCELLID: number;
  NAME?: string;
  BL?: string;
}

interface WfsFeature {
  type: "Feature";
  properties: WfsFeatureProperties;
  geometry: WfsPolygonGeometry | null;
}

interface WfsFeatureCollection {
  type: "FeatureCollection";
  features: WfsFeature[];
}

/** Compute the centroid of a flat polygon ring (array of [lon, lat] pairs). */
function polygonCentroid(ring: number[][]): { lat: number; lon: number } | null {
  if (ring.length === 0) return null;
  let sumLon = 0;
  let sumLat = 0;
  // The ring may close on itself (last point === first point); include all.
  for (const [lon, lat] of ring) {
    sumLon += lon;
    sumLat += lat;
  }
  return { lon: sumLon / ring.length, lat: sumLat / ring.length };
}

/** Haversine great-circle distance between two lat/lon points (in km). */
function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371; // km
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class WeatherClient {
  private readonly baseUrl: string;
  private readonly wfsBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly resolveStation: StationResolver;
  private readonly radiusKm: number;

  /**
   * Lazy-initialised WFS catalog cache: warncellId (string) → centroid.
   * Populated on first call to getWarningsForStation, then reused.
   */
  private wfsCentroidCache: Map<string, { lat: number; lon: number }> | null =
    null;

  constructor(opts: WeatherClientOptions) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.wfsBaseUrl = opts.wfsBaseUrl ?? DEFAULT_WFS_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.resolveStation = opts.stationResolver;
    this.radiusKm = opts.radiusKm ?? DEFAULT_RADIUS_KM;
  }

  async getWarningsForStation(
    evaNumber: string,
    atTime?: string,
  ): Promise<{
    stationCoordinates: StationCoordinates;
    warnings: WeatherWarning[];
  }> {
    const [stationCoordinates, parsed, centroidMap] = await Promise.all([
      this.resolveStation(evaNumber),
      this.fetchAndParse(),
      this.getWfsCentroids(),
    ]);

    const filterAtMs = atTime ? Date.parse(atTime) : Date.now();
    const allWarnings: WeatherWarning[] = [];
    const buckets = parsed.warnings ?? {};

    for (const [warncellId, list] of Object.entries(buckets)) {
      for (const raw of list) {
        const mapped = this.mapWarning(raw);
        if (!mapped) continue;

        // Time filter: warning must be active at filterAtMs.
        const startMs = Date.parse(mapped.start);
        const endMs = Date.parse(mapped.end);
        if (filterAtMs < startMs || filterAtMs > endMs) continue;

        // Coordinate filter (Option B — WFS centroid haversine):
        // Look up the centroid for this warncell in the WFS catalog.
        // If the catalog has an entry, apply haversine distance check.
        // If the catalog has no entry for this cell, keep the warning
        // (conservative: unknown geometry → assume relevant).
        const centroid = centroidMap.get(warncellId);
        if (centroid !== undefined) {
          const distance = haversineKm(stationCoordinates, centroid);
          if (distance > this.radiusKm) continue;
        }

        allWarnings.push(mapped);
      }
    }

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

  /**
   * Fetch (and cache) the DWD WFS warncell catalog, returning a map from
   * warncellId (string) to polygon centroid coordinates.
   *
   * The catalog is requested once and stored in this.wfsCentroidCache.
   * If the fetch fails, an empty map is returned for that call only (not cached),
   * so coordinate filtering is effectively bypassed rather than crashing the whole
   * request. The cache stays null so subsequent calls will retry.
   */
  private async getWfsCentroids(): Promise<
    Map<string, { lat: number; lon: number }>
  > {
    if (this.wfsCentroidCache !== null) return this.wfsCentroidCache;

    const url =
      `${this.wfsBaseUrl}/geoserver/dwd/ows` +
      `?service=WFS&version=1.0.0&request=GetFeature` +
      `&typeName=dwd:Warngebiete_Kreise&outputFormat=application/json`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let collection: WfsFeatureCollection;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        // Non-fatal: return empty map for this call only, do not cache.
        // Leave this.wfsCentroidCache null so next call retries.
        return new Map();
      }
      collection = (await res.json()) as WfsFeatureCollection;
    } catch {
      // Network error or abort — return empty map for this call only, do not cache.
      // Leave this.wfsCentroidCache null so next call retries.
      return new Map();
    } finally {
      clearTimeout(timer);
    }

    const map = new Map<string, { lat: number; lon: number }>();
    for (const feature of collection.features ?? []) {
      const id = String(feature.properties.WARNCELLID);
      const geom = feature.geometry;
      if (!geom || geom.type !== "Polygon" || !geom.coordinates[0]) continue;
      const centroid = polygonCentroid(geom.coordinates[0]);
      if (centroid) map.set(id, centroid);
    }

    this.wfsCentroidCache = map;
    return map;
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
