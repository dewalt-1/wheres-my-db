import { z } from "zod";
import type { TransitousClient } from "../clients/transitous.js";
import type { JourneyOption, SourcedResponse } from "../types.js";

// A transfer is risky when the live gap between arriving and leaving is below this.
export const BUFFER_MINUTES = 5;

const Input = z.object({
  fromStationId: z.string().min(1),
  toStationId: z.string().min(1),
  time: z.string().optional(),
});

export function makePlanJourneyTool(client: Pick<TransitousClient, "planJourney">) {
  return {
    spec: {
      name: "plan_journey",
      description:
        "Plan a journey between two stations (ids from resolve_station). Returns options with live times and delays per leg, including walking legs between platforms. Each option lists riskyTransfers: changes where the predicted arrival leaves less than 5 minutes before the next train's predicted departure.",
      inputSchema: {
        type: "object" as const,
        properties: {
          fromStationId: { type: "string" as const, description: "Origin station id" },
          toStationId: { type: "string" as const, description: "Destination station id" },
          time: { type: "string" as const, description: "Optional ISO 8601 departure time; defaults to now" },
        },
        required: ["fromStationId", "toStationId"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ fromStationId, toStationId, time }: z.infer<typeof Input>): Promise<SourcedResponse<JourneyOption[]>> => {
      const options = await client.planJourney(fromStationId, toStationId, time);
      return { data: options.map(annotateRiskyTransfers), source: "transitous" };
    },
  };
}

function annotateRiskyTransfers(option: JourneyOption): JourneyOption {
  // Walking legs are part of the transfer, so compare consecutive trains.
  const trains = option.legs.filter((leg) => leg.tripId !== undefined);
  const risky: Array<{ atStation: string; reason: string }> = [];
  for (let i = 0; i < trains.length - 1; i++) {
    const arrive = trains[i];
    const depart = trains[i + 1];
    const arriveAt = Date.parse(arrive.predictedArrival);
    const departAt = Date.parse(depart.predictedDeparture);
    if (!Number.isFinite(arriveAt) || !Number.isFinite(departAt)) continue;
    const gapMinutes = (departAt - arriveAt) / 60000;
    if (gapMinutes < BUFFER_MINUTES) {
      risky.push({
        atStation: arrive.to.name,
        reason: `Only ${Math.max(0, Math.round(gapMinutes))} min between predicted arrival of ${arrive.trainName} and departure of ${depart.trainName} (buffer is ${BUFFER_MINUTES} min)`,
      });
    }
  }
  return { ...option, riskyTransfers: risky };
}
