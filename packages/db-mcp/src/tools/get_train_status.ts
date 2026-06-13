import { z } from "zod";
import type { ProviderRouter } from "../clients/provider.js";
import type { SourcedResponse, TrainStatus } from "../types.js";
import type { ToolDef } from "./runtime.js";

const Input = z.object({
  name: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export function makeGetTrainStatusTool(router: ProviderRouter): ToolDef<z.infer<typeof Input>> {
  return {
    spec: {
      name: "get_train_status",
      description:
        "Return full per-stop status for a train: scheduled & predicted times, delays in minutes, platform changes, outgoing connections at each stop with their own delays, and train-level messages. Use the train name (e.g. 'ICE 597') and optional date.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Train name (e.g. 'ICE 597')" },
          date: { type: "string" as const, description: "Optional YYYY-MM-DD" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ name, date }: z.infer<typeof Input>): Promise<SourcedResponse<TrainStatus>> => router.getTrainStatus(name, date),
  };
}
