// High-level marudor (bahn.expert) client.
// Each method maps a tRPC procedure response to a domain type.

import type { Station } from "../types.js";
import { MarudorRpc, type MarudorRpcOptions } from "./marudor-rpc.js";

// Raw shape returned by stopPlace.byTerm (subset we care about)
interface RawStopPlace {
  evaNumber?: unknown;
  name?: unknown;
  availableTransports?: string[];
  position?: { latitude?: number; longitude?: number };
  ril100?: unknown;
  stationId?: unknown;
}

export class MarudorClient {
  private readonly rpc: MarudorRpc;

  constructor(opts?: MarudorRpcOptions) {
    this.rpc = new MarudorRpc(opts);
  }

  /**
   * Search for stations by name or partial name.
   * Procedure: stopPlace.byTerm
   * Input: { searchTerm: string }
   * Returns Station[] with evaNumber and name populated.
   */
  async searchStations(query: string): Promise<Station[]> {
    const raw = await this.rpc.query<unknown>("stopPlace.byTerm", {
      searchTerm: query,
    });

    if (!Array.isArray(raw)) {
      return [];
    }

    const stations: Station[] = [];
    for (const item of raw as RawStopPlace[]) {
      const evaNumber =
        typeof item.evaNumber === "string" ? item.evaNumber : undefined;
      const name = typeof item.name === "string" ? item.name : undefined;
      if (evaNumber && name) {
        stations.push({ evaNumber, name });
      }
    }
    return stations;
  }
}
