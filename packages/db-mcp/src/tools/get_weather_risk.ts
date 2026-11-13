import { z } from "zod";
import { ProviderError } from "../errors.js";
import type { SourcedResponse, WeatherWarning } from "../types.js";
import type { WeatherClient } from "../clients/weather.js";

const Input = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  atTime: z.string().optional(),
});

interface GetWeatherRiskData {
  warnings: WeatherWarning[];
  warningsUnavailable?: boolean;
}

export function makeGetWeatherRiskTool(client: Pick<WeatherClient, "getWarningsNear">) {
  return {
    spec: {
      name: "get_weather_risk",
      description:
        "Official weather warnings (frost, heat, storm, snow, etc.) from the German weather service DWD for the district containing a point, e.g. a station's coordinates from resolve_station. Without atTime it returns every warning not yet expired, including ones starting later (check start/end); with atTime only warnings in force at that moment. Severity level is DWD's: 1=minor, 2=moderate, 3=severe, 4=extreme. Soft-fails: if the weather service is unreachable it returns warningsUnavailable=true with no warnings, never an error.",
      inputSchema: {
        type: "object" as const,
        properties: {
          lat: { type: "number" as const, description: "Latitude" },
          lon: { type: "number" as const, description: "Longitude" },
          atTime: { type: "string" as const, description: "Optional ISO 8601 timestamp; defaults to now" },
        },
        required: ["lat", "lon"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ lat, lon, atTime }: z.infer<typeof Input>): Promise<SourcedResponse<GetWeatherRiskData>> => {
      try {
        const res = await client.getWarningsNear({ lat, lon }, atTime);
        return { data: { warnings: res.warnings }, source: "dwd" };
      } catch (err) {
        if (err instanceof ProviderError) {
          return { data: { warnings: [], warningsUnavailable: true }, source: "dwd" };
        }
        throw err;
      }
    },
  };
}
