import { z } from "zod";
import type { TransitousClient } from "../clients/transitous.js";
import { areaMapUrl } from "../map-link.js";
import { renderLateTrains } from "../render.js";
import type { SourcedResponse, TrainInArea } from "../types.js";

const KM_PER_DEGREE_LAT = 111;

const Input = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  radiusKm: z.number().min(1).max(150).optional(),
  minDelayMinutes: z.number().min(0).optional(),
});

interface LateTrainsData {
  trainsChecked: number;
  lateTrains: TrainInArea[];
}

export function makeGetLateTrainsTool(client: Pick<TransitousClient, "getTrainsInArea">) {
  return {
    spec: {
      name: "get_late_trains",
      description:
        "List trains currently running late around a point (station coordinates from resolve_station), worst first. Each has an estimated position, predicted delay at its next stop, and likelyStuck=true when it is losing 10+ minutes between two stops (an inference, not a confirmed standstill). feedsDisagree=true means two data sources report this run with clearly different delays or positions; say so rather than picking one. Also returns a text diagram and a link to a live map of the area. Always put this diagram in your reply, unchanged, in a code block, even in a short answer: it is part of the answer, not debug output. Give the map link straight away. Default radius 40 km, default minimum delay 5 min.",
      inputSchema: {
        type: "object" as const,
        properties: {
          lat: { type: "number" as const, description: "Latitude of the centre point" },
          lon: { type: "number" as const, description: "Longitude of the centre point" },
          radiusKm: { type: "number" as const, description: "Search radius in km (default 40, max 150)" },
          minDelayMinutes: { type: "number" as const, description: "Only return trains at least this late (default 5)" },
        },
        required: ["lat", "lon"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ lat, lon, radiusKm, minDelayMinutes }: z.infer<typeof Input>): Promise<SourcedResponse<LateTrainsData>> => {
      const radius = radiusKm ?? 40;
      const minDelay = minDelayMinutes ?? 5;
      const dLat = radius / KM_PER_DEGREE_LAT;
      const dLon = radius / (KM_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
      const trains = await client.getTrainsInArea({
        minLat: lat - dLat,
        minLon: lon - dLon,
        maxLat: lat + dLat,
        maxLon: lon + dLon,
      });
      const lateTrains = trains
        .filter((t) => t.delayMinutes >= minDelay)
        .sort((a, b) => b.delayMinutes - a.delayMinutes);
      return {
        data: { trainsChecked: trains.length, lateTrains },
        source: "transitous",
        diagram: renderLateTrains(lateTrains, { trainsChecked: trains.length }),
        mapUrl: areaMapUrl(lat, lon, radius, minDelay),
      };
    },
  };
}
