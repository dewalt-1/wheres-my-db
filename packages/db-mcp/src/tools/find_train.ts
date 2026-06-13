import { z } from "zod";
import type { ProviderRouter } from "../clients/provider.js";
import type { SourcedResponse, TrainIdentifier } from "../types.js";
import type { ToolDef } from "./runtime.js";

const Input = z.object({
  name: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export function makeFindTrainTool(router: ProviderRouter): ToolDef<z.infer<typeof Input>> {
  return {
    spec: {
      name: "find_train",
      description:
        "Look up a train by its name/number (e.g. 'ICE 597'). Returns a TrainIdentifier whose journeyId is needed for get_train_status. Optional date narrows to a specific operating day.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Train name, e.g. 'ICE 597'" },
          date: { type: "string" as const, description: "Optional YYYY-MM-DD" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ name, date }: z.infer<typeof Input>): Promise<SourcedResponse<TrainIdentifier>> => {
      const res = await router.getTrainStatus(name, date);
      return { data: res.data.identifier, source: res.source, degraded: res.degraded };
    },
  };
}
