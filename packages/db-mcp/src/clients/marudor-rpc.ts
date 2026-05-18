// Low-level tRPC GET transport for the marudor (bahn.expert) service.
//
// Protocol:
//   Request:  GET /rpc/<procedure>?input=<URL-encoded JSON-stringified devalue array>
//   Response: { result: { data: "<devalue-stringified payload>" } }
//
// Encoding recipe (per docs/marudor-api.md):
//   devalueStr = devalue.stringify(inputObject)   → JSON flat-array string
//   urlParam   = encodeURIComponent(JSON.stringify(devalueStr))
//   URL        = <baseUrl>/rpc/<procedure>?input=<urlParam>
//
// Decoding recipe:
//   outer = JSON.parse(responseBody)
//   inner = devalue.parse(outer.result.data)

import * as devalue from "devalue";
import { ProviderError } from "../errors.js";

export interface MarudorRpcOptions {
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
}

const DEFAULT_BASE_URL = "https://bahn.expert";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_USER_AGENT =
  "db-mcp/0.1 (https://github.com/yourself/db-delay-predictor)";

export class MarudorRpc {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(opts: MarudorRpcOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  async query<T>(procedure: string, input: unknown): Promise<T> {
    // Encode input per the tRPC+devalue protocol
    const devalueStr = devalue.stringify(input);
    const urlParam = encodeURIComponent(JSON.stringify(devalueStr));
    const url = `${this.baseUrl}/rpc/${procedure}?input=${urlParam}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
        },
      });
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("aborted"))
      ) {
        throw new ProviderError(
          `Request to ${procedure} timed out after ${this.timeoutMs}ms`,
          "marudor",
          "timeout",
          err,
        );
      }
      throw new ProviderError(
        `Network error querying ${procedure}: ${String(err)}`,
        "marudor",
        "http",
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        // ignore
      }
      throw new ProviderError(
        `HTTP ${response.status} from ${procedure}: ${body.slice(0, 200)}`,
        "marudor",
        "http",
      );
    }

    // Parse outer JSON wrapper
    let outer: unknown;
    let rawBody = "";
    try {
      rawBody = await response.text();
      outer = JSON.parse(rawBody);
    } catch (err) {
      throw new ProviderError(
        `Failed to JSON-parse outer response from ${procedure}`,
        "marudor",
        "parse",
        err,
      );
    }

    // Validate shape: { result: { data: string } }
    const outerObj = outer as Record<string, unknown>;
    const result =
      typeof outerObj.result === "object" && outerObj.result !== null
        ? (outerObj.result as Record<string, unknown>)
        : null;
    if (result === null || typeof result.data !== "string") {
      throw new ProviderError(
        `Unexpected response shape from ${procedure}: ${rawBody.slice(0, 200)}`,
        "marudor",
        "parse",
      );
    }

    const dataStr = result.data;

    // Decode the inner devalue payload
    try {
      return devalue.parse(dataStr) as T;
    } catch (err) {
      throw new ProviderError(
        `Failed to devalue-parse inner data from ${procedure}`,
        "marudor",
        "parse",
        err,
      );
    }
  }
}
