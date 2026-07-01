# DWD warnings API — observed contracts

Date probed: 2026-07-01

## Endpoint

- URL: `https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json`
- Method: GET
- Auth: none
- Response format: **JSONP** — body starts with `warnWetter.loadWarnings(` and ends with `);`.
  Strip prefix `warnWetter.loadWarnings(` and suffix `);` (after trimming trailing whitespace/newline) before calling `JSON.parse`.

## Response shape (after unwrapping)

```jsonc
{
  "time": 1782940895000,           // epoch ms — timestamp of the snapshot
  "warnings": {
    "<warncellId>": [ /* Warning[] */ ],
    ...
  },
  "vorabInformation": {            // advance/forecast warnings, same shape as `warnings`
    ...
  },
  "copyright": "Copyright Deutscher Wetterdienst"
}
```

- `time`: epoch ms snapshot timestamp.
- `warnings`: object keyed by warncell ID strings (e.g. `"109184000"`, `"901054001"`).
  Each value is an array of Warning objects (usually 1 entry, occasionally more for multiple simultaneous warnings in one cell).
- `vorabInformation`: advance warnings (days ahead). Same Warning shape. Often empty `{}`.
- `copyright`: literal string, always present.

## Warning object

All fields observed in live responses:

| Field | Type | Notes |
|-------|------|-------|
| `state` | string | German Bundesland name, e.g. `"Bayern"` |
| `stateShort` | string | Two-letter code, e.g. `"BY"`, `"SH"`, `"NW"` |
| `type` | number | Legacy numeric DWD event code (see table below) |
| `level` | number | Official DWD severity: 1=advisory, 2=warning, 3=severe, 4=extreme |
| `start` | number | Epoch ms — map to `WeatherWarning.start` via `new Date(start).toISOString()` |
| `end` | number | Epoch ms — map to `WeatherWarning.end` via `new Date(end).toISOString()` |
| `regionName` | string | Human-readable warncell name, e.g. `"Kreis und Stadt München"` — map to `WeatherWarning.areaName` |
| `event` | string | Text event code — **map to `WeatherWarning.type`** (see table below) |
| `headline` | string | Short warning headline — map to `WeatherWarning.headline` |
| `description` | string | Longer description — map to `WeatherWarning.description`. Can be empty string. |
| `instruction` | string | Action instructions. NOT part of `WeatherWarning` interface; may be included as extended data. |
| `altitudeStart` | number \| null | Lower altitude bound in metres; `null` when not applicable |
| `altitudeEnd` | number \| null | Upper altitude bound in metres; `null` when not applicable |

### `WeatherWarning` field mapping

| `WeatherWarning` field | DWD source field | Transform |
|------------------------|-----------------|-----------|
| `type` | `event` | Direct string copy (`"HITZE"`, `"STARKES GEWITTER"`, etc.) |
| `level` | `level` | Direct — already 1–4 |
| `headline` | `headline` | Direct string copy |
| `description` | `description` | Direct string copy |
| `start` | `start` | `new Date(start).toISOString()` |
| `end` | `end` | `new Date(end).toISOString()` |
| `areaName` | `regionName` | Direct string copy |

### Observed `event` / `type` codes

| `type` (numeric) | `event` (string) | Description |
|-----------------|-----------------|-------------|
| `0` | `STARKES GEWITTER` | Severe thunderstorm |
| `1` | `WINDBÖEN` | Wind gusts |
| `1` | `STURMBÖEN` | Storm gusts (same numeric code, different severity) |
| `7` | `HITZE` | Heat warning |
| (other) | `GEWITTER` | Thunderstorm |
| (other) | `STURM` | Storm |
| (other) | `SCHNEE` | Snow |
| (other) | `FROST` | Frost |
| (other) | `NEBEL` | Fog |
| (other) | `REGEN` | Rain |
| (other) | `GLATTEIS` | Black ice |

Note: the numeric `type` field is a legacy code and multiple event strings can share the same numeric code. Always use the `event` string field for semantic mapping, not `type`.

## Coordinate filtering strategy

**No coordinate data is embedded in the warnings response.** The `warnings` object only carries a `warncellId` key (the property name) and the Warning object fields listed above. There are no `coords`, `geometry`, `lat`, `lon`, or `bbox` fields.

### Option A — WFS warncell catalog (recommended)

DWD publishes a WFS endpoint with full polygon geometry per warncell:

```
https://maps.dwd.de/geoserver/dwd/ows
  ?service=WFS
  &version=1.0.0
  &request=GetFeature
  &typeName=dwd:Warngebiete_Kreise
  &outputFormat=application/json
```

Returns GeoJSON FeatureCollection. Each feature has:
- `properties.WARNCELLID`: integer matching the numeric warncell ID key in `warnings.json`
- `properties.NAME`: human-readable cell name
- `properties.BL`: Bundesland two-letter code
- `geometry`: Polygon in EPSG:4326 (lon/lat)

This lets us build a lookup table `warncellId → centroid` or `warncellId → polygon`, then do point-in-polygon or haversine-to-centroid filtering for a given station coordinate.

The catalog is ~450 features and loads in a single request. It can be fetched once at startup and cached in memory (it changes rarely).

### Option B — regionName fuzzy match (fallback)

If the WFS catalog is unavailable, fall back to matching the station's `place` or city name against `regionName`. Example: a station in `"München Hbf"` would match `"Kreis und Stadt München"`. This is lossy (district borders don't align perfectly with station city names) but covers the most common use case.

### Option C — Bundesland-level match (coarsest fallback)

If neither works, compare `stateShort` against the station's inferred Bundesland. E.g. all warnings with `stateShort === "BY"` are relevant for Bavarian stations. Very coarse — a station in Kiel would see warnings for all of Schleswig-Holstein.

**Recommendation for Task 4:** Implement Option A as primary. Cache the WFS catalog at `WeatherClient` init time (or lazily on first request). Use Option B as fallback when the catalog fetch fails.

## Known wrinkles

1. **JSONP, not JSON** — the body cannot be passed directly to `JSON.parse`. Strip `warnWetter.loadWarnings(` prefix and `);` suffix first.
2. **Empty `description`** — some warnings have `description: ""`. The mapper should tolerate this.
3. **Epoch ms timestamps** — `start` and `end` are milliseconds since epoch, not ISO 8601. Convert at the mapping layer with `new Date(ms).toISOString()`.
4. **`vorabInformation`** — advance warnings use the same shape. The client may optionally include these (filtered by a configurable lookahead window); for v0.2.1 it is safe to ignore them.
5. **No per-warning coordinates** — coordinate resolution requires the separate WFS catalog (see above).
6. **Multiple warnings per warncell** — a warncell array can contain more than one Warning object (e.g. overlapping time windows). The mapper must iterate all entries, not just `[0]`.
7. **Warncell ID type mismatch** — in `warnings.json` the IDs are object keys (strings), but in the WFS catalog `WARNCELLID` is an integer. Normalise to string for lookup: `String(feature.properties.WARNCELLID)`.
8. **Altitude-bounded warnings** — `altitudeStart` / `altitudeEnd` are present for mountain/high-altitude warnings. These can be safely ignored for standard station matching unless the station has elevation data.
