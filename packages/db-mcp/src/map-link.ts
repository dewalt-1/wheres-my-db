// Links to the live map page (docs/index.html, published with GitHub Pages).
// The page reads the same data source directly in the browser, so a link is
// all a tool needs to hand over. Override the address with DB_MCP_MAP_URL.

const DEFAULT_MAP_URL = "https://dewalt-1.github.io/wheres-my-db/";

function base(): string {
  return process.env.DB_MCP_MAP_URL ?? DEFAULT_MAP_URL;
}

/** Map of trains around a point. */
export function areaMapUrl(lat: number, lon: number, radiusKm: number, minDelayMinutes: number): string {
  const params = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    r: String(radiusKm),
    min: String(minDelayMinutes),
  });
  return `${base()}?${params.toString()}`;
}

/** Map of one train's route. */
export function trainMapUrl(tripId: string): string {
  return `${base()}?${new URLSearchParams({ trip: tripId }).toString()}`;
}
