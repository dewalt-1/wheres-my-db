import { z } from "zod";
import type { TransitousClient } from "../clients/transitous.js";
import type { SourcedResponse, Station } from "../types.js";

const Input = z.object({
  query: z.string().min(1, "query must not be empty"),
});

export function makeResolveStationTool(client: Pick<TransitousClient, "searchStations">) {
  return {
    spec: {
      name: "resolve_station",
      description:
        "Resolve a station name (e.g. 'Köln Hbf', 'Frankfurt') to candidate stations with an id and coordinates. Returns several matches, best first; the caller picks or asks the user. Pass the id unchanged to the other tools.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string" as const, description: "Free-text station name" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ query }: z.infer<typeof Input>): Promise<SourcedResponse<Station[]>> => ({
      data: await client.searchStations(query),
      source: "transitous",
    }),
  };
}
