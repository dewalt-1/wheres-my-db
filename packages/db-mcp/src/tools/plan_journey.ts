import { z } from "zod";
import type { ProviderRouter } from "../clients/provider.js";
import type { JourneyOption, SourcedResponse } from "../types.js";
import type { ToolDef } from "./runtime.js";

// A transfer is risky when remaining time after predicted arrival is below this buffer.
export const BUFFER_MINUTES = 5;

const Input = z.object({
  fromEva: z.string().min(1),
  toEva: z.string().min(1),
  isoTime: z.string().optional(),
});

export function makePlanJourneyTool(router: ProviderRouter): ToolDef<z.infer<typeof Input>> {
  return {
    spec: {
      name: "plan_journey",
      description:
        "Plan a journey between two stations (by EVA number, obtained via resolve_station). Returns options with per-leg delays. Each option flags risky transfers — a transfer is risky when the incoming train's predicted arrival leaves less than 5 minutes before the connecting train departs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          fromEva: { type: "string" as const, description: "Origin EVA number" },
          toEva: { type: "string" as const, description: "Destination EVA number" },
          isoTime: { type: "string" as const, description: "Optional ISO-8601 desired departure time" },
        },
        required: ["fromEva", "toEva"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ fromEva, toEva, isoTime }: z.infer<typeof Input>): Promise<SourcedResponse<JourneyOption[]>> => {
      const res = await router.searchJourneys(fromEva, toEva, isoTime);
      const annotated = res.data.map(annotateRiskyTransfers);
      return { data: annotated, source: res.source, degraded: res.degraded };
    },
  };
}

function annotateRiskyTransfers(option: JourneyOption): JourneyOption {
  const risky: Array<{ atStation: string; reason: string }> = [];
  for (let i = 0; i < option.legs.length - 1; i++) {
    const arrive = option.legs[i];
    const depart = option.legs[i + 1];
    const arriveAt = new Date(arrive.predictedArrival).getTime();
    const departAt = new Date(depart.predictedDeparture).getTime();
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
