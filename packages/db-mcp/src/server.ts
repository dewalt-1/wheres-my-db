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
import { createCache } from "./cache.js";
import { makeResolveStationTool } from "./tools/resolve_station.js";
import { makeFindTrainTool } from "./tools/find_train.js";
import { makeGetTrainStatusTool } from "./tools/get_train_status.js";
import { makePlanJourneyTool } from "./tools/plan_journey.js";
import { makeGetDisruptionsTool } from "./tools/get_disruptions.js";
import { asError, asResult } from "./tools/runtime.js";
import type { SourcedResponse } from "./types.js";

export interface CreateServerOptions {
  providers?: { router: ProviderRouter };
}

export interface ServerHandle {
  server: Server;
  listTools: () => Promise<{ tools: Tool[] }>;
  callTool: (name: string, args: unknown) => Promise<CallToolResult>;
}

export function createServer(opts: CreateServerOptions = {}): ServerHandle {
  const router = opts.providers?.router ?? buildDefaultRouter();

  const tools = [
    makeResolveStationTool(router),
    makeFindTrainTool(router),
    makeGetTrainStatusTool(router),
    makePlanJourneyTool(router),
    makeGetDisruptionsTool(router),
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

function buildDefaultRouter(): ProviderRouter {
  const marudor = new MarudorClient();
  const dbRest = new DbRestClient();
  const router = new ProviderRouter(marudor, dbRest);
  return wrapWithCache(router);
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
