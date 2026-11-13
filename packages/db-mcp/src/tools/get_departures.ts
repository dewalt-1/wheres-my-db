import { z } from "zod";
import type { TransitousClient } from "../clients/transitous.js";
import type { Departure, SourcedResponse } from "../types.js";

const Input = z.object({
  stationId: z.string().min(1),
  time: z.string().optional(),
  limit: z.number().int().min(1).max(120).optional(),
});

export function makeGetDeparturesTool(client: Pick<TransitousClient, "getDepartures">) {
  return {
    spec: {
      name: "get_departures",
      description:
        "Live departure board for a station: long-distance, regional, S-Bahn, U-Bahn and tram. Each entry has scheduled and predicted departure, delay in minutes, platform, cancellation, and a tripId for get_train_status. realTime=false means timetable-only data for that entry.",
      inputSchema: {
        type: "object" as const,
        properties: {
          stationId: { type: "string" as const, description: "Station id from resolve_station" },
          time: { type: "string" as const, description: "Optional ISO 8601 start time; defaults to now" },
          limit: { type: "number" as const, description: "Max departures to return (default 30, max 120)" },
        },
        required: ["stationId"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ stationId, time, limit }: z.infer<typeof Input>): Promise<SourcedResponse<Departure[]>> => ({
      data: await client.getDepartures(stationId, { time, limit }),
      source: "transitous",
    }),
  };
}
