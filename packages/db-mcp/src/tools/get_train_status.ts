import { z } from "zod";
import type { TransitousClient } from "../clients/transitous.js";
import { trainMapUrl } from "../map-link.js";
import { renderTrainStrip } from "../render.js";
import type { SourcedResponse, TrainStatus } from "../types.js";

const Input = z.object({
  tripId: z.string().min(1),
});

export function makeGetTrainStatusTool(client: Pick<TransitousClient, "getTrainStatus">) {
  return {
    spec: {
      name: "get_train_status",
      description:
        "Full per-stop status for one train run: scheduled and predicted times, arrival and departure delay in minutes at every stop, platform changes, cancellations and service alerts. Also returns a text diagram of the route to show the user as-is, and a link to a live map of the route. Takes a tripId from find_train, get_departures or plan_journey.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tripId: { type: "string" as const, description: "Trip id from find_train, get_departures or plan_journey" },
        },
        required: ["tripId"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ tripId }: z.infer<typeof Input>): Promise<SourcedResponse<TrainStatus>> => {
      const status = await client.getTrainStatus(tripId);
      return {
        data: status,
        source: "transitous",
        diagram: renderTrainStrip(status),
        mapUrl: trainMapUrl(status.tripId),
      };
    },
  };
}
