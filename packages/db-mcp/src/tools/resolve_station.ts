import { z } from "zod";
import type { ProviderRouter } from "../clients/provider.js";
import type { Station, SourcedResponse } from "../types.js";
import type { ToolDef } from "./runtime.js";

const Input = z.object({
  query: z.string().min(1, "query must not be empty"),
});

export function makeResolveStationTool(router: ProviderRouter): ToolDef<z.infer<typeof Input>> {
  return {
    spec: {
      name: "resolve_station",
      description:
        "Resolve a fuzzy station name (e.g. 'Koeln Hbf', 'Frankfurt') to candidate stations with EVA numbers. Returns multiple matches; the caller picks or disambiguates.",
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
    handler: async ({ query }: z.infer<typeof Input>): Promise<SourcedResponse<Station[]>> =>
      router.searchStations(query),
  };
}
