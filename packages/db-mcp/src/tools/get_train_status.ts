import { z } from "zod";
import type { TransitousClient } from "../clients/transitous.js";
import type { DbTimetablesClient } from "../clients/db-timetables.js";
import { ProviderError } from "../errors.js";
import { trainMapUrl } from "../map-link.js";
import { renderTrainStrip } from "../render.js";
import { analyseLineAhead, boxAround, lastPassedIndex, stretchAhead } from "../line-ahead.js";
import type { LineAhead, SourcedResponse, Stopover, TrainNotices, TrainStatus } from "../types.js";

/** Optional source of DB notices; absent when no DB API key is configured. */
export type NoticeSource = Pick<DbTimetablesClient, "getNoticesForTrain">;

export type TrainStatusResult = TrainStatus & {
  /** DB notices at the user's boarding stop (delay reasons, catering, etc.). */
  boardingNotices: TrainNotices;
  /** Your train checked against trains ahead on its route. Needs no DB key. */
  lineAhead: LineAhead;
};

type TrainSource = Pick<TransitousClient, "getTrainStatus"> & Partial<Pick<TransitousClient, "getTrainsInArea">>;

/** Check the trains ahead; failures never break the train answer. */
async function lookUpLineAhead(client: TrainSource, status: TrainStatus, boarding: number | undefined): Promise<LineAhead> {
  if (!client.getTrainsInArea) return { status: "not-checked", reason: "Area data unavailable" };
  if (!status.realTime) return { status: "not-checked", reason: "No live data for this train" };
  const now = Date.now();
  const last = lastPassedIndex(status.stopovers, now);
  // Estimate for the user's stop; without one, for the next stop.
  const target = boarding ?? Math.min(last + 1, status.stopovers.length - 1);
  if (target <= last) return { status: "not-checked", reason: "The train has already left that stop" };
  try {
    const box = boxAround(stretchAhead(status, target, now));
    const others = await client.getTrainsInArea(box);
    return analyseLineAhead(status, target, others, now);
  } catch (err) {
    if (err instanceof ProviderError) return { status: "not-checked", reason: err.message };
    throw err;
  }
}

/** Modes DB's timetable data covers; trams, U-Bahn and buses are not in it. */
const DB_MODES = new Set(["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN"]);

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

async function lookUpNotices(
  notices: NoticeSource | undefined,
  status: TrainStatus,
  boarding: number | undefined,
): Promise<TrainNotices> {
  if (!notices) return { status: "off" };
  if (!DB_MODES.has(status.mode)) return { status: "not-covered" };
  if (boarding === undefined) {
    return { status: "error", message: "No boarding stop given (pass boardLat/boardLon)" };
  }
  const stop = status.stopovers[boarding];
  if (!status.trainNumber) return { status: "error", station: stop.stationName, message: "Train number unknown" };
  try {
    const found = await notices.getNoticesForTrain(
      stop.stationName,
      status.trainNumber,
      stop.scheduledDeparture ?? stop.scheduledArrival,
    );
    if (!found) return { status: "station-not-found", station: stop.stationName };
    return { status: "ok", station: found.station, notices: found.notices };
  } catch (err) {
    if (err instanceof ProviderError) return { status: "error", station: stop.stationName, message: err.message };
    throw err;
  }
}

export function makeGetTrainStatusTool(
  client: TrainSource,
  notices?: NoticeSource,
) {
  return {
    spec: {
      name: "get_train_status",
      description:
        "Full per-stop status for one train run: scheduled and predicted times, arrival and departure delay in minutes at every stop, platform changes, cancellations and service alerts. Takes a tripId from find_train, get_departures or plan_journey. If you know where the user boards, pass that station's coordinates as boardLat/boardLon so their stop is marked. lineAhead checks the train against other trains ahead of it on its route: status 'held-up' means a train ahead will hold it up, with an estimate beyond the official prediction. Also returns a text diagram of the route to show as-is, and a link to a live map of this train. boardingNotices holds DB's notices at the boarding stop (delay reasons, missing catering, missing coaches, bike spaces, disruptions); status 'off' means the optional DB API key is not configured. Answer the user's question first, then ask whether they want the live view; give the link only if they say yes.",
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
    handler: async ({ tripId, boardLat, boardLon }: z.infer<typeof Input>): Promise<SourcedResponse<TrainStatusResult>> => {
      const status = await client.getTrainStatus(tripId);
      const boarding =
        boardLat !== undefined && boardLon !== undefined
          ? nearestStopIndex(status.stopovers, { lat: boardLat, lon: boardLon })
          : undefined;
      const [boardingNotices, lineAhead] = await Promise.all([
        lookUpNotices(notices, status, boarding),
        lookUpLineAhead(client, status, boarding),
      ]);
      return {
        data: { ...status, boardingNotices, lineAhead },
        source: "transitous",
        diagram: renderTrainStrip(status, Date.now(), boarding, boardingNotices, lineAhead),
        mapUrl: trainMapUrl(status.tripId, boarding),
      };
    },
  };
}
