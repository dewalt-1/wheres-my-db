import { z } from "zod";
import { ProviderError } from "../errors.js";
import type {
  SourcedResponse,
  WeatherWarning,
} from "../types.js";
import type {
  StationCoordinates,
  WeatherClient,
} from "../clients/weather.js";

const Input = z.object({
  evaNumber: z.string().min(1, "evaNumber must not be empty"),
  atTime: z.string().optional(),
});

interface GetWeatherRiskData {
  warnings: WeatherWarning[];
  stationCoordinates: StationCoordinates;
  warningsUnavailable?: boolean;
}

const ZERO_COORDS: StationCoordinates = { lat: 0, lon: 0, name: "" };

export function makeGetWeatherRiskTool(client: WeatherClient) {
  return {
    spec: {
      name: "get_weather_risk",
      description:
        "Return active and upcoming weather warnings (heat, storm, etc.) from the German weather service DWD that affect a given station. Use to explain unexplained delays or to proactively check the forecast for a planned trip. Severity is DWD's official 1–4 level: 1=advisory, 4=extreme. Soft-fails: if the weather service is unreachable, returns warningsUnavailable=true with empty warnings, never an isError.",
      inputSchema: {
        type: "object" as const,
        properties: {
          evaNumber: {
            type: "string" as const,
            description: "EVA number of the station to check (from resolve_station)",
          },
          atTime: {
            type: "string" as const,
            description: "Optional ISO 8601 timestamp; defaults to now",
          },
        },
        required: ["evaNumber"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({
      evaNumber,
      atTime,
    }: z.infer<typeof Input>): Promise<SourcedResponse<GetWeatherRiskData>> => {
      try {
        const res = await client.getWarningsForStation(evaNumber, atTime);
        return {
          data: {
            warnings: res.warnings,
            stationCoordinates: res.stationCoordinates,
          },
          source: "dwd",
          degraded: false,
        };
      } catch (err) {
        if (err instanceof ProviderError) {
          return {
            data: {
              warnings: [],
              stationCoordinates: ZERO_COORDS,
              warningsUnavailable: true,
            },
            source: "dwd",
            degraded: false,
          };
        }
        throw err;
      }
    },
  };
}
