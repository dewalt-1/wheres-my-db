import { z } from "zod";
import type { TransitousClient } from "../clients/transitous.js";
import { trainMapUrl } from "../map-link.js";
import { renderTrainStrip } from "../render.js";
import type { SourcedResponse, Stopover, TrainStatus } from "../types.js";

/** A stop further than this from the given point is not the user's stop. */
const MAX_BOARDING_DISTANCE_KM = 2;

const Input = z
  .object({
    tripId: z.string().min(1),
    boardLat: z.number().min(-90).max(90).optional(),
    boardLon: z.number().min(-180).max(180).optional(),
  })
  .refine((v) => (v.boardLat === undefined) === (v.boardLon === undefined), {
    message: "boardLat and boardLon must be given together",
  });

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Index of the stop nearest to the point, if one is close enough. */
function nearestStopIndex(stopovers: Stopover[], point: { lat: number; lon: number }): number | undefined {
  let best: number | undefined;
  let bestKm = MAX_BOARDING_DISTANCE_KM;
  stopovers.forEach((stop, i) => {
    const km = distanceKm(stop, point);
    if (km <= bestKm) {
      best = i;
      bestKm = km;
    }
  });
  return best;
}

export function makeGetTrainStatusTool(client: Pick<TransitousClient, "getTrainStatus">) {
  return {
    spec: {
      name: "get_train_status",
      description:
        "Full per-stop status for one train run: scheduled and predicted times, arrival and departure delay in minutes at every stop, platform changes, cancellations and service alerts. Takes a tripId from find_train, get_departures or plan_journey. If you know where the user boards, pass that station's coordinates as boardLat/boardLon so their stop is marked. Also returns a text diagram of the route to show as-is, and a link to a live map of this train. Answer the user's question first, then ask whether they want the live view; give the link only if they say yes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tripId: { type: "string" as const, description: "Trip id from find_train, get_departures or plan_journey" },
          boardLat: { type: "number" as const, description: "Latitude of the station where the user boards (from resolve_station)" },
          boardLon: { type: "number" as const, description: "Longitude of the station where the user boards" },
        },
        required: ["tripId"],
        additionalProperties: false,
      },
    },
    schema: Input,
    handler: async ({ tripId, boardLat, boardLon }: z.infer<typeof Input>): Promise<SourcedResponse<TrainStatus>> => {
      const status = await client.getTrainStatus(tripId);
      const boarding =
        boardLat !== undefined && boardLon !== undefined
          ? nearestStopIndex(status.stopovers, { lat: boardLat, lon: boardLon })
          : undefined;
      return {
        data: status,
        source: "transitous",
        diagram: renderTrainStrip(status, Date.now(), boarding),
        mapUrl: trainMapUrl(status.tripId, boarding),
      };
    },
  };
}
