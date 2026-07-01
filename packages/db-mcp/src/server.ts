import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import { MarudorClient } from "./clients/marudor.js";
import { DbRestClient } from "./clients/db-rest.js";
import { ProviderRouter } from "./clients/provider.js";
import { WeatherClient } from "./clients/weather.js";
import { createCache } from "./cache.js";
import { ProviderError } from "./errors.js";
import { makeResolveStationTool } from "./tools/resolve_station.js";
import { makeFindTrainTool } from "./tools/find_train.js";
import { makeGetTrainStatusTool } from "./tools/get_train_status.js";
import { makePlanJourneyTool } from "./tools/plan_journey.js";
import { makeGetDisruptionsTool } from "./tools/get_disruptions.js";
import { makeGetWeatherRiskTool } from "./tools/get_weather_risk.js";
import { asError, asResult } from "./tools/runtime.js";
import type { SourcedResponse, WeatherWarning } from "./types.js";

export interface CreateServerOptions {
  providers?: {
    router: ProviderRouter;
    weather: Pick<WeatherClient, "getWarningsForStation">;
  };
}

export interface ServerHandle {
  server: Server;
  listTools: () => Promise<{ tools: Tool[] }>;
  callTool: (name: string, args: unknown) => Promise<CallToolResult>;
}

export function createServer(opts: CreateServerOptions = {}): ServerHandle {
  const providers = opts.providers ?? buildDefaultProviders();
  const router = providers.router;
  const weather = providers.weather;

  const tools = [
    makeResolveStationTool(router),
    makeFindTrainTool(router),
    makeGetTrainStatusTool(router),
    makePlanJourneyTool(router),
    makeGetDisruptionsTool(router),
    makeGetWeatherRiskTool(weather as WeatherClient),
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
    { name: "db-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, listTools);
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(req.params.name, req.params.arguments),
  );

  return { server, listTools, callTool };
}

function buildDefaultProviders(): {
  router: ProviderRouter;
  weather: WeatherClient;
} {
  const marudor = new MarudorClient();
  const dbRest = new DbRestClient();
  const baseRouter = new ProviderRouter(marudor, dbRest);
  const router = wrapWithCache(baseRouter);

  const baseWeather = new WeatherClient({
    stationResolver: async (evaNumber: string) => {
      // Reuse marudor station search to get lat/lon for an EVA number.
      // Picks the first result whose evaNumber matches exactly.
      const stations = await marudor.searchStations(evaNumber);
      const match = stations.find((s) => s.evaNumber === evaNumber);
      if (!match) {
        throw new ProviderError(
          `Could not resolve coordinates for station ${evaNumber}`,
          "dwd",
          "not_found",
        );
      }
      const pos = match.position;
      if (!pos) {
        throw new ProviderError(
          `Station ${evaNumber} has no coordinates`,
          "dwd",
          "not_found",
        );
      }
      return { lat: pos.lat, lon: pos.lon, name: match.name };
    },
  });
  const weather = wrapWeatherWithCache(baseWeather);

  return { router, weather };
}

function wrapWeatherWithCache(client: WeatherClient): WeatherClient {
  const cache = createCache<{
    stationCoordinates: { lat: number; lon: number; name: string };
    warnings: WeatherWarning[];
  }>({ max: 200, ttlMs: 5 * 60 * 1000 });
  const original = client.getWarningsForStation.bind(client);
  client.getWarningsForStation = (eva: string, atTime?: string) => {
    const key = `weather:${eva}:${atTime ?? "now"}`;
    return cache.getOrCompute(key, () => original(eva, atTime));
  };
  return client;
}

function wrapWithCache(router: ProviderRouter): ProviderRouter {
  // 5-minute TTL, 500 entries — well within memory for a personal MCP.
  const cache = createCache<SourcedResponse<unknown>>({ max: 500, ttlMs: 5 * 60 * 1000 });
  const wrap = <Args extends unknown[]>(
    label: string,
    fn: (...args: Args) => Promise<SourcedResponse<unknown>>,
  ) => {
    return async (...args: Args) => {
      const key = `${label}:${JSON.stringify(args)}`;
      return cache.getOrCompute(key, () => fn(...args)) as Promise<SourcedResponse<unknown>>;
    };
  };
  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(router)), router) as ProviderRouter;
  wrapped.searchStations = wrap("searchStations", router.searchStations.bind(router)) as never;
  wrapped.getTrainStatus = wrap("getTrainStatus", router.getTrainStatus.bind(router)) as never;
  wrapped.searchJourneys = wrap("searchJourneys", router.searchJourneys.bind(router)) as never;
  wrapped.getDisruptions = wrap("getDisruptions", router.getDisruptions.bind(router)) as never;
  return wrapped;
}
