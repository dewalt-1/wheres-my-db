import { z } from "zod";
import type { TransitousClient } from "../clients/transitous.js";
import type { DbTimetablesClient } from "../clients/db-timetables.js";
import { dhidOf, type OpenBoardsClient } from "../clients/open-boards.js";
import { findCulprit, MIN_DELAY_TO_EXPLAIN, orderOf, orderOnBoard, trainsOnStretch } from "../culprit.js";
import { ProviderError } from "../errors.js";
import { trainMapUrl } from "../map-link.js";
import { renderTrainStrip } from "../render.js";
import { analyseLineAhead, boxAround, lastPassedIndex, stretchAhead } from "../line-ahead.js";
import type {
  Culprit,
  LineAhead,
  Notice,
  RouteCountries,
  SourcedResponse,
  Stopover,
  TrainInArea,
  TrainNotices,
  TrainStatus,
} from "../types.js";

/** Optional DB sources; absent when no DB API key is configured. */
export type NoticeSource = Pick<OpenBoardsClient, "getNoticesForTrain" | "getBoard"> & {
  /**
   * DB's older Timetables API also covers DB trains at stations abroad.
   * Works only with keys subscribed before November 2026; DB plans to switch
   * it off in mid-2027. Remove then.
   */
  legacy?: Pick<DbTimetablesClient, "getNoticesForTrain">;
};

export type TrainStatusResult = TrainStatus & {
  /** DB notices at the user's boarding stop (delay reasons, catering, etc.). */
  boardingNotices: TrainNotices;
  /** Your train checked against trains ahead on its route. Needs no DB key. */
  lineAhead: LineAhead;
  /** The part of the route ahead that is outside Germany. Needs no DB key. */
  countries: RouteCountries;
  /** Which train may be holding this one up. Better with a DB key, works without. */
  culprit: Culprit;
};

type TrainSource = Pick<TransitousClient, "getTrainStatus"> &
  Partial<Pick<TransitousClient, "getTrainsInArea" | "countryAt">>;

const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  AT: "Austria", BE: "Belgium", CH: "Switzerland", CZ: "Czechia", DK: "Denmark",
  FR: "France", IT: "Italy", LU: "Luxembourg", NL: "the Netherlands", PL: "Poland",
};

/** Stops still ahead: from the last stop the train left (it may sit just past it). */
function stopsAhead(status: TrainStatus, now: number): number[] {
  const first = Math.max(0, lastPassedIndex(status.stopovers, now));
  return status.stopovers.map((_, i) => i).filter((i) => i >= first);
}

/**
 * Country of each stop ahead. Every few stops are checked first; only if one
 * is outside Germany are all of them checked, which keeps lookups low.
 */
async function lookUpCountries(client: TrainSource, status: TrainStatus, now: number): Promise<{ countries: RouteCountries }> {
  const byStop = new Map<number, string>();
  if (!client.countryAt) return { countries: { status: "not-checked", reason: "Country lookup unavailable" } };
  const ahead = stopsAhead(status, now);
  const lookUp = async (indexes: number[]) => {
    for (const i of indexes) {
      if (byStop.has(i)) continue;
      const stop = status.stopovers[i];
      const country = await client.countryAt!(stop.lat, stop.lon);
      if (country) byStop.set(i, country);
    }
  };
  try {
    const sample = ahead.filter((_, n) => n % 4 === 0 || n === ahead.length - 1);
    await lookUp(sample);
    if ([...byStop.values()].some((c) => c !== "DE")) await lookUp(ahead);
  } catch (err) {
    if (err instanceof ProviderError) return { countries: { status: "not-checked", reason: err.message } };
    throw err;
  }
  const abroad: NonNullable<RouteCountries["abroad"]> = [];
  for (const i of ahead) {
    const country = byStop.get(i);
    if (!country || country === "DE") continue;
    const last = abroad[abroad.length - 1];
    const name = status.stopovers[i].stationName;
    if (last && last.country === country) last.stops.push(name);
    else abroad.push({ country, countryName: COUNTRY_NAMES[country] ?? country, stops: [name] });
  }
  return {
    countries: abroad.length > 0 ? { status: "crosses-border", abroad } : { status: "germany-only" },
  };
}

/** At most this many trains and DB boards are looked up to find a culprit. */
const MAX_SUSPECTS = 5;
const MAX_BOARDS = 4;

/** Never breaks the train answer: any failure becomes "not-checked". */
async function lookUpCulprit(
  client: TrainSource,
  notices: NoticeSource | undefined,
  status: TrainStatus,
  now: number,
): Promise<Culprit> {
  if (!client.getTrainsInArea) return { status: "not-checked", reason: "Area data unavailable" };
  if (!DB_MODES.has(status.mode)) return { status: "not-checked", reason: "Only checked for trains" };
  if (!status.realTime) return { status: "not-checked", reason: "No live data for this train" };
  const last = lastPassedIndex(status.stopovers, now);
  const next = last + 1;
  if (last < 0 || next >= status.stopovers.length) return { status: "not-checked", reason: "The train is not under way" };
  const nextStop = status.stopovers[next];
  const delayMinutes = nextStop.arrivalDelayMinutes ?? nextStop.departureDelayMinutes ?? 0;
  if (delayMinutes < MIN_DELAY_TO_EXPLAIN) return { status: "not-checked", reason: "Not late enough to look for a cause" };
  if (!status.path || status.path.length < 2) return { status: "not-checked", reason: "No route line for this train" };
  const mine = status.stopovers[last];
  try {
    const onStretch = trainsOnStretch(status, last, next, await client.getTrainsInArea(boxAround([mine, nextStop], 8)));
    const worst = [...onStretch]
      .sort((a, b) => Number(b.likelyStuck) - Number(a.likelyStuck) || b.delayMinutes - a.delayMinutes)
      .slice(0, MAX_SUSPECTS);
    const suspects = await Promise.all(
      worst.map(async (train) => {
        const other = await client.getTrainStatus(train.tripId).catch((err) => {
          if (err instanceof ProviderError) return undefined;
          throw err;
        });
        return { train, number: other?.trainNumber, order: orderOf(mine, other) };
      }),
    );
    const { boards, ownReasons } = await lookUpDbCauses(notices, status, mine, nextStop, onStretch, now);
    // DB's recorded departures at the last stop beat the other source's.
    const atMine = boards[0]?.station === mine.stationName ? boards[0].trains : [];
    const ordered = suspects.map((s) => ({
      ...s,
      order: (status.trainNumber && s.number && orderOnBoard(atMine, status.trainNumber, s.number)) || s.order,
    }));
    return findCulprit({ delayMinutes, mode: status.mode, suspects: ordered, boards, ownReasons });
  } catch (err) {
    if (err instanceof ProviderError) return { status: "not-checked", reason: err.message };
    throw err;
  }
}

/** DB boards along the stretch and DB's reasons for this train; empty without a key or on failure. */
async function lookUpDbCauses(
  notices: NoticeSource | undefined,
  status: TrainStatus,
  mine: Stopover,
  nextStop: Stopover,
  onStretch: TrainInArea[],
  now: number,
): Promise<{ boards: Array<{ station: string; trains: Awaited<ReturnType<NoticeSource["getBoard"]>> }>; ownReasons: string[] }> {
  if (!notices) return { boards: [], ownReasons: [] };
  const quiet = async <T>(work: Promise<T>): Promise<T | undefined> =>
    work.catch((err) => {
      if (err instanceof ProviderError) return undefined;
      throw err;
    });
  // Stations the train passes on this stretch, taken from local trains on it.
  const stations = new Map<string, string>();
  for (const s of [
    { id: mine.stationId, name: mine.stationName },
    // Furthest along first: that is where a train waiting before the next stop is.
    ...[...onStretch]
      .sort((a, b) => Math.hypot(a.fromLat - nextStop.lat, a.fromLon - nextStop.lon) - Math.hypot(b.fromLat - nextStop.lat, b.fromLon - nextStop.lon))
      .map((t) => ({ id: t.fromStopId ?? "", name: t.fromStation })),
    { id: nextStop.stationId, name: nextStop.stationName },
  ]) {
    const dhid = dhidOf(s.id);
    if (dhid && !stations.has(dhid)) stations.set(dhid, s.name);
  }
  // Back to shortly before this train left its last stop.
  const left = Date.parse(mine.predictedDeparture ?? mine.predictedArrival ?? "");
  const from = Math.min(now - 60 * 60_000, (Number.isNaN(left) ? now : left) - 30 * 60_000);
  const boards = await Promise.all(
    [...stations].slice(0, MAX_BOARDS).map(async ([dhid, station]) => ({
      station,
      trains: (await quiet(notices.getBoard(dhid, from, now + 30 * 60_000))) ?? [],
    })),
  );
  const number = status.trainNumber;
  const reasons = (found: { notices: Notice[] } | null | undefined) =>
    (found?.notices ?? []).filter((n) => n.kind === "delay-reason").map((n) => n.text);
  let ownReasons: string[] = [];
  if (number) {
    // The newest reason sits at the next stop, which may be abroad.
    ownReasons = notices.legacy
      ? reasons(await quiet(notices.legacy.getNoticesForTrain(nextStop.stationName, number, nextStop.scheduledArrival ?? nextStop.scheduledDeparture)))
      : [];
    if (ownReasons.length === 0) {
      ownReasons = reasons(
        await quiet(notices.getNoticesForTrain(mine, number, mine.scheduledDeparture ?? new Date(now).toISOString(), mine.predictedDeparture)),
      );
    }
  }
  return { boards, ownReasons };
}

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
    const scheduled = stop.scheduledDeparture ?? stop.scheduledArrival;
    if (!scheduled) return { status: "error", station: stop.stationName, message: "No timetable time at this stop" };
    const found = await notices.getNoticesForTrain(
      stop,
      status.trainNumber,
      scheduled,
      stop.predictedDeparture ?? stop.predictedArrival,
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
        "Full per-stop status for one train run: scheduled and predicted times, arrival and departure delay in minutes at every stop, platform changes, cancellations and service alerts. Takes a tripId from find_train, get_departures or plan_journey. If you know where the user boards, pass that station's coordinates as boardLat/boardLon so their stop is marked. lineAhead checks the train against other trains ahead of it on its route: status 'held-up' means a train ahead will hold it up, with an estimate beyond the official prediction. Also returns a text diagram of the route and a link to a live map of this train. Always put this diagram in your reply, unchanged, in a code block, even in a short answer: it is part of the answer, not debug output. boardingNotices holds DB's notices at the boarding stop (delay reasons, missing catering, missing coaches, bike spaces, disruptions); status 'off' means the optional DB API key is not configured. culprit looks for the train holding this one up when it is 10+ minutes late: candidates are suspects with evidence and a confidence, never certain, so say 'may be' and give the evidence; queuedBehind are trains stuck behind it and not the cause; otherFaults may run the other way; notices are DB's disruption texts along the stretch (DB key). If status is 'none-found', say the train holding it up could not be identified. countries.abroad lists the stops ahead that are outside Germany, by country: German sources (DB, the German feed) don't carry disruption notices there, so tell the user that part isn't covered and, if you can search the web, check that country's rail operator for disruptions. Answer the user's question first, then ask whether they want the live view; give the link only if they say yes.",
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
      const now = Date.now();
      const [boardingNotices, lineAhead, { countries }, culprit] = await Promise.all([
        lookUpNotices(notices, status, boarding),
        lookUpLineAhead(client, status, boarding),
        lookUpCountries(client, status, now),
        lookUpCulprit(client, notices, status, now),
      ]);
      // The route line is thousands of points: for the checks, not for the agent.
      const { path: _path, ...answer } = status;
      return {
        data: { ...answer, boardingNotices, lineAhead, countries, culprit },
        source: "transitous",
        diagram: renderTrainStrip(status, now, boarding, boardingNotices, lineAhead, countries, culprit),
        mapUrl: trainMapUrl(status.tripId, boarding),
      };
    },
  };
}
