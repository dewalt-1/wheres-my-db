import { z } from "zod";
import type { ProviderRouter } from "../clients/provider.js";
import type { SourcedResponse, Disruption } from "../types.js";
import type { ToolDef } from "./runtime.js";

const Input = z.object({
  evaNumber: z.string().optional(),
});

export function makeGetDisruptionsTool(router: ProviderRouter): ToolDef<z.infer<typeof Input>> {
  return {
    spec: {
      name: "get_disruptions",
      description:
        "Return current Störungsmeldungen (DB disruption messages). Optionally filter by evaNumber to get disruptions affecting a given station. Severity is classified heuristically: high = signalling/medical, medium = points/overhead-line, low = everything else.",
      inputSchema: {
        type: "object" as const,
        properties: {
          evaNumber: { type: "string" as const, description: "Optional EVA number to scope" },
        },
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ evaNumber }: z.infer<typeof Input>): Promise<SourcedResponse<Disruption[]>> =>
      router.getDisruptions({ evaNumber }),
  };
}
