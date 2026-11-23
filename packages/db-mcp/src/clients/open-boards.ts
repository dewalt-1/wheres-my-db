// Client for DB's OpenBoards API (DB API Marketplace), the successor of the
// Timetables API. Optional: used only when the user has a free DB API key.
// Departure boards of German stations, with DB's delay reasons, quality
// notices and disruption texts in plain words. German stations only.

import { ProviderError } from "../errors.js";
import { CANCEL_ONLY, CODE_TEXT } from "../db/codes.js";
import type { Notice } from "../types.js";

const DEFAULT_BASE_URL = "https://apis.deutschebahn.com/db-api-marketplace/apis/open-boards/v1";
const DEFAULT_TIMEOUT_MS = 15000;
const BOARD_CACHE_MS = 60 * 1000;
/** The API's maximum per kind of train; busy boards are cut off there. */
const MAX_ENTRIES = 50;

export interface BoardDisruption {
  id: string;
  /** DB's cause, e.g. "CONSTRUCTION" or "TECHNICAL_PROBLEM_RAILWAY_SECTION". */
  cause: string;
  text: string;
}

export interface BoardTrain {
  /** The same for one run at every station. */
  journeyId: string;
  name: string;
  number: string;
  scheduled: string;
  time: string;
  cancelled: boolean;
  causes: number[];
  quality: number[];
  disruptions: BoardDisruption[];
}

/** The German stop code inside a Transitous stop id ("de-DELFI_de:05315:11201:7:72"). */
export function dhidOf(stopId: string): string | undefined {
  return /(?:^|_)(de:\d{5}:\d+)/.exec(stopId)?.[1];
}

interface RawMessage {
  messageID?: number;
  code?: string;
  cause?: string;
  disruptionID?: string;
  descriptions?: Array<{ language?: string; text?: string; textShort?: string }>;
}

function text(m: RawMessage): string {
  const all = m.descriptions ?? [];
  const best = all.find((d) => d.language === "eng") ?? all[0];
  return (best?.text ?? best?.textShort ?? "").trim();
}

interface RawBoard {
  departures?: Array<{
    journeyId?: string;
    time?: string;
    timeSchedule?: string;
    cancelled?: boolean;
    messages?: number[];
    journeyInfo?: { headerJourneyNumber?: number };
    transport?: { journeyDescription?: string; journeyNumber?: number };
  }>;
  messages?: Partial<Record<"disruptions" | "risCauseCodes" | "risQualityDeviations", RawMessage[]>>;
}

export function parseOpenBoard(raw: RawBoard): BoardTrain[] {
  const byId = (group: RawMessage[] | undefined) => new Map((group ?? []).map((m) => [m.messageID, m]));
  const causes = byId(raw.messages?.risCauseCodes);
  const quality = byId(raw.messages?.risQualityDeviations);
  const disruptions = byId(raw.messages?.disruptions);
  const codes = (from: Map<number | undefined, RawMessage>, ids: number[]) =>
    ids.map((id) => Number(from.get(id)?.code)).filter((c) => Number.isInteger(c));
  return (raw.departures ?? []).map((d) => {
    const ids = d.messages ?? [];
    return {
      journeyId: d.journeyId ?? "",
      name: d.transport?.journeyDescription ?? "",
      number: String(d.transport?.journeyNumber ?? d.journeyInfo?.headerJourneyNumber ?? ""),
      scheduled: d.timeSchedule ?? "",
      time: d.time ?? d.timeSchedule ?? "",
      cancelled: d.cancelled === true,
      causes: codes(causes, ids),
      quality: codes(quality, ids),
      disruptions: ids
        .map((id) => disruptions.get(id))
        .filter((m): m is RawMessage => m !== undefined)
        .map((m) => ({ id: m.disruptionID ?? String(m.messageID), cause: m.cause ?? "", text: text(m) }))
        .filter((m) => m.text !== ""),
    };
  });
}

/** What DB says about one train: delay reasons, quality, then disruptions. */
export function noticesOf(train: BoardTrain): Notice[] {
  const coded = (kind: "delay-reason" | "quality", list: number[]): Notice[] =>
    [...new Set(list)].filter((c) => CODE_TEXT[c] && !CANCEL_ONLY.has(c)).map((code) => ({ kind, text: CODE_TEXT[code], code }));
  return [
    ...coded("delay-reason", train.causes),
    ...coded("quality", train.quality),
    ...train.disruptions.map((d): Notice => ({ kind: "disruption", text: d.text })),
  ];
}

export class OpenBoardsClient {
  private readonly boards = new Map<string, { at: number; trains: BoardTrain[] }>();

  constructor(
    private readonly opts: { clientId: string; apiKey: string; baseUrl?: string; timeoutMs?: number },
  ) {}

  /** Departures at a station (by German stop code) between two instants. */
  async getBoard(dhid: string, fromMs: number, toMs: number): Promise<BoardTrain[]> {
    // Whole 5-minute steps, so repeated lookups share one cached answer.
    const step = 5 * 60_000;
    const start = new Date(Math.floor(fromMs / step) * step).toISOString();
    const end = new Date(Math.ceil(toMs / step) * step).toISOString();
    const key = `${dhid}|${start}|${end}`;
    const cached = this.boards.get(key);
    if (cached && Date.now() - cached.at < BOARD_CACHE_MS) return cached.trains;
    const trains = parseOpenBoard(
      (await this.post("/departures", {
        stopPlaceOrStation: { dhids: [dhid] },
        timeWindow: { timeStart: start, timeEnd: end },
        maxEntriesPerTransportType: MAX_ENTRIES,
        languages: ["eng", "deu"],
      })) as RawBoard,
    );
    this.boards.set(key, { at: Date.now(), trains });
    return trains;
  }

  /** Notices for one train at one German stop; null if the stop is not in DB's data. */
  async getNoticesForTrain(
    stop: { stationName: string; stationId: string },
    trainNumber: string,
    scheduled: string,
    expected: string = scheduled,
  ): Promise<{ station: string; notices: Notice[] } | null> {
    const dhid = dhidOf(stop.stationId);
    if (!dhid) return null;
    const times = [Date.parse(scheduled), Date.parse(expected)];
    const board = await this.getBoard(dhid, Math.min(...times) - 10 * 60_000, Math.max(...times) + 10 * 60_000);
    const number = trainNumber.replace(/^0+/, "");
    const train = board
      .filter((t) => t.number === number)
      .sort((a, b) => Math.abs(Date.parse(a.scheduled) - times[0]) - Math.abs(Date.parse(b.scheduled) - times[0]))[0];
    return { station: stop.stationName, notices: train ? noticesOf(train) : [] };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.opts.baseUrl ?? DEFAULT_BASE_URL}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "DB-Client-Id": this.opts.clientId,
          "DB-Api-Key": this.opts.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(
          /subscription/i.test(raw)
            ? "DB API key works but is not subscribed to OpenBoards (subscribe to its Free plan in the DB API Marketplace)"
            : "DB API rejected the key (check DB_CLIENT_ID and DB_API_KEY)",
          "db",
          "http",
        );
      }
      if (!res.ok) throw new ProviderError(`DB OpenBoards returned HTTP ${res.status}`, "db", "http");
      return JSON.parse(raw);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderError(`DB API timed out after ${timeoutMs}ms`, "db", "timeout");
      }
      if (err instanceof SyntaxError) throw new ProviderError("DB OpenBoards sent an unreadable answer", "db", "parse", err);
      throw new ProviderError(`DB API request failed: ${(err as Error).message}`, "db", "http", err);
    } finally {
      clearTimeout(timer);
    }
  }
}
