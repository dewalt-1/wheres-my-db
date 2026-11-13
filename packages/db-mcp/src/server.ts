import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import { TransitousClient } from "./clients/transitous.js";
import { WeatherClient } from "./clients/weather.js";
import { createCache } from "./cache.js";
import { makeResolveStationTool } from "./tools/resolve_station.js";
import { makeGetDeparturesTool } from "./tools/get_departures.js";
import { makeFindTrainTool } from "./tools/find_train.js";
import { makeGetTrainStatusTool } from "./tools/get_train_status.js";
import { makePlanJourneyTool } from "./tools/plan_journey.js";
import { makeGetLateTrainsTool } from "./tools/get_late_trains.js";
import { makeGetWeatherRiskTool } from "./tools/get_weather_risk.js";
import { asError, asResult } from "./tools/runtime.js";
import type { SourcedResponse } from "./types.js";

/** The train-data methods the tools need. */
export type TrainData = Pick<
  TransitousClient,
  | "searchStations"
  | "getDepartures"
  | "findTrain"
  | "getTrainStatus"
  | "planJourney"
  | "getTrainsInArea"
>;

/** The weather methods the tools need. */
export type WeatherData = Pick<WeatherClient, "getWarningsNear">;

export interface CreateServerOptions {
  providers?: { trains: TrainData; weather: WeatherData };
}

export interface ServerHandle {
  server: Server;
  listTools: () => Promise<{ tools: Tool[] }>;
  callTool: (name: string, args: unknown) => Promise<CallToolResult>;
}

// Live delays change by the minute, so cache briefly: long enough to absorb
// repeated calls inside one conversation turn, short enough to stay current.
const TRAIN_CACHE_TTL_MS = 60 * 1000;
// Station names and weather warnings move slowly.
const SLOW_CACHE_TTL_MS = 5 * 60 * 1000;

export function createServer(opts: CreateServerOptions = {}): ServerHandle {
  const { trains, weather } = opts.providers ?? buildDefaultProviders();

  const tools = [
    makeResolveStationTool(trains),
    makeGetDeparturesTool(trains),
    makeFindTrainTool(trains),
    makeGetTrainStatusTool(trains),
    makePlanJourneyTool(trains),
    makeGetLateTrainsTool(trains),
    makeGetWeatherRiskTool(weather),
  ];
  const byName = new Map(tools.map((t) => [t.spec.name, t]));

  const listTools = async () => ({ tools: tools.map((t) => t.spec) });

  const callTool = async (name: string, args: unknown): Promise<CallToolResult> => {
    const tool = byName.get(name);
    if (!tool) return asError(`Unknown tool: ${name}`);
    try {
      const parsed = tool.schema.parse(args ?? {});
      const res = (await tool.handler(parsed as never)) as SourcedResponse<unknown>;
      return asResult(res);
    } catch (err) {
      if (err instanceof ZodError) {
        return asError(`Invalid arguments for ${name}: ${err.message}`);
      }
      return asError(`Tool ${name} failed: ${(err as Error).message}`);
    }
  };

  const server = new Server(
    { name: "db-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, listTools);
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(req.params.name, req.params.arguments),
  );

  return { server, listTools, callTool };
}

function buildDefaultProviders(): { trains: TrainData; weather: WeatherData } {
  const client = new TransitousClient();
  const weatherClient = new WeatherClient();
  const live = createCache<object>({ max: 500, ttlMs: TRAIN_CACHE_TTL_MS });
  const slow = createCache<object>({ max: 500, ttlMs: SLOW_CACHE_TTL_MS });

  // Cache by method name + arguments. Failures are not cached.
  const cached = <A extends unknown[], R extends object>(
    cache: typeof live,
    label: string,
    fn: (...args: A) => Promise<R>,
  ) => {
    return (...args: A): Promise<R> =>
      cache.getOrCompute(`${label}:${JSON.stringify(args)}`, () => fn(...args)) as Promise<R>;
  };

  return {
    trains: {
      searchStations: cached(slow, "searchStations", client.searchStations.bind(client)),
      getDepartures: cached(live, "getDepartures", client.getDepartures.bind(client)),
      findTrain: cached(live, "findTrain", client.findTrain.bind(client)),
      getTrainStatus: cached(live, "getTrainStatus", client.getTrainStatus.bind(client)),
      planJourney: cached(live, "planJourney", client.planJourney.bind(client)),
      getTrainsInArea: cached(live, "getTrainsInArea", client.getTrainsInArea.bind(client)),
    },
    weather: {
      getWarningsNear: cached(slow, "getWarningsNear", weatherClient.getWarningsNear.bind(weatherClient)),
    },
  };
}
