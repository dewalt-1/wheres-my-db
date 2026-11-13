import { z } from "zod";
import type { TransitousClient } from "../clients/transitous.js";
import type { Departure, SourcedResponse } from "../types.js";

const Input = z.object({
  name: z.string().min(1),
  stationId: z.string().min(1),
  time: z.string().optional(),
});

export function makeFindTrainTool(client: Pick<TransitousClient, "findTrain">) {
  return {
    spec: {
      name: "find_train",
      description:
        "Find a named train (e.g. 'ICE 107', 'RE1', 'S19') on the departure board of a station the train calls at. A station is required: there is no lookup by train name alone. Returns matching departures with their tripId; lines like 'S19' return several runs, pick by time and direction.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Train or line name, e.g. 'ICE 107'" },
          stationId: { type: "string" as const, description: "Id of a station the train departs from (resolve_station)" },
          time: { type: "string" as const, description: "Optional ISO 8601 time to search from; defaults to now" },
        },
        required: ["name", "stationId"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ name, stationId, time }: z.infer<typeof Input>): Promise<SourcedResponse<Departure[]>> => ({
      data: await client.findTrain(name, stationId, time),
      source: "transitous",
    }),
  };
}
