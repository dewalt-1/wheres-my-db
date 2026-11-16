// Client for DB's official Timetables API (IRIS), via the DB API Marketplace.
// Optional: used only when the user has a (free) DB API key. It adds the
// notices DB attaches to trains at a station: delay reasons ("Repair to a
// signal"), quality notices ("No food or drink available") and disruption
// notices. Responses are XML; the shapes we read are small, so they are
// parsed with regular expressions rather than a dependency.

import { ProviderError } from "../errors.js";
import { CANCEL_ONLY, CODE_TEXT, DISRUPTION_CATEGORY, SUPERSEDES } from "../db/codes.js";
import type { Notice } from "../types.js";

const DEFAULT_BASE_URL = "https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1";
const DEFAULT_TIMEOUT_MS = 15000;
/** The free plan allows 60 calls a minute; one board per station per minute is plenty. */
const BOARD_CACHE_MS = 60 * 1000;
/** The planned timetable for an hour rarely changes. */
const PLAN_CACHE_MS = 15 * 60 * 1000;

export interface DbTimetablesOptions {
  clientId: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface RawMessage {
  type: string;
  code?: number;
  category?: string;
  ts?: string;
}

interface RawStop {
  /** Links the same train run across DB's timetable (plan) and changes (fchg) feeds. */
  id: string;
  category: string;
  number: string;
  plannedTimes: string[];
  messages: RawMessage[];
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** DB timestamps are yyMMddHHmm in German local time. */
function dbTimeToIso(ts: string | undefined): string | undefined {
  if (!ts || !/^\d{10}$/.test(ts)) return undefined;
  const [y, mo, d, h, mi] = [0, 2, 4, 6, 8].map((i) => Number(ts.slice(i, i + 2)));
  // Find the UTC instant whose Berlin wall-clock time matches.
  const guess = Date.UTC(2000 + y, mo - 1, d, h, mi);
  const berlin = new Date(guess).toLocaleString("sv-SE", { timeZone: "Europe/Berlin" });
  const offset = Date.parse(`${berlin.replace(" ", "T")}Z`) - guess;
  return new Date(guess - offset).toISOString();
}

/** ISO instant to DB's yyMMddHHmm in German local time. */
export function isoToDbTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "2-digit", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}`;
}

export function parseBoard(xml: string): RawStop[] {
  const stops: RawStop[] = [];
  for (const block of xml.matchAll(/<s\s([^>]*)>([\s\S]*?)<\/s>/g)) {
    const id = attrs(block[1]).id ?? "";
    const body = block[2];
    const tl = body.match(/<tl\s[^>]*\/?>/);
    const tlAttrs = tl ? attrs(tl[0]) : {};
    const plannedTimes: string[] = [];
    for (const ev of body.matchAll(/<(?:ar|dp)\s[^>]*>/g)) {
      const pt = attrs(ev[0]).pt;
      if (pt) plannedTimes.push(pt);
    }
    const messages: RawMessage[] = [];
    for (const m of body.matchAll(/<m\s[^>]*\/?>/g)) {
      const a = attrs(m[0]);
      messages.push({
        type: a.t ?? "",
        code: a.c !== undefined && /^\d+$/.test(a.c) ? Number(a.c) : undefined,
        category: a.cat,
        ts: a.ts,
      });
    }
    stops.push({ id, category: tlAttrs.c ?? "", number: (tlAttrs.n ?? "").replace(/^0+/, ""), plannedTimes, messages });
  }
  return stops;
}

/**
 * Current notices from a train's raw messages: delay reasons (latest
 * first, no duplicates), quality notices with cancelled ones removed, and
 * disruption categories.
 */
export function currentNotices(messages: RawMessage[]): Notice[] {
  const ordered = [...messages].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  const delay = new Map<number, Notice>();
  let quality: Notice[] = [];
  const disruption = new Map<string, Notice>();

  for (const m of ordered) {
    const since = dbTimeToIso(m.ts);
    if (m.type === "d" && m.code !== undefined && CODE_TEXT[m.code]) {
      delay.delete(m.code);
      delay.set(m.code, { kind: "delay-reason", text: CODE_TEXT[m.code], code: m.code, since });
    } else if ((m.type === "q" || m.type === "f") && m.code !== undefined && CODE_TEXT[m.code]) {
      const cancelled = new Set([...(SUPERSEDES[m.code] ?? []), m.code]);
      quality = quality.filter((n) => !cancelled.has(n.code ?? -1));
      if (!CANCEL_ONLY.has(m.code)) quality.push({ kind: "quality", text: CODE_TEXT[m.code], code: m.code, since });
    } else if (m.type === "h" && m.category) {
      const text = DISRUPTION_CATEGORY[m.category] ?? "Disruption";
      disruption.set(text, { kind: "disruption", text, since });
    }
  }
  return [...[...delay.values()].reverse(), ...quality.reverse(), ...disruption.values()];
}

/** Station-name spellings to try, since DB's lookup wants the exact name. */
export function nameVariants(name: string): string[] {
  // DB writes "Hamm(Westf)Hbf": no spaces around brackets.
  const tidy = (s: string) => s.replace(/\s+\(/g, "(").replace(/\)\s+/g, ")").replace(/\s{2,}/g, " ").trim();
  const short = name.replace(/Hauptbahnhof/g, "Hbf").replace(/,\s*/g, " ");
  const noBf = short.replace(/\s+Bf\.?$/, "");
  return [...new Set([name, tidy(name), tidy(short), tidy(noBf)])];
}

function comparable(name: string): string {
  return name.toLowerCase().replace(/hauptbahnhof/g, "hbf").replace(/\bbf\.?$/, "").replace(/[^a-z0-9äöüß]/g, "");
}

export class DbTimetablesClient {
  private readonly clientId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly stationIds = new Map<string, string | null>();
  private readonly boards = new Map<string, { at: number; stops: RawStop[] }>();
  private readonly plans = new Map<string, { at: number; stops: RawStop[] }>();

  constructor(opts: DbTimetablesOptions) {
    this.clientId = opts.clientId;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** DB station number (EVA) for a station name, or null if no confident match. */
  async findStationEva(name: string): Promise<string | null> {
    if (this.stationIds.has(name)) return this.stationIds.get(name) ?? null;
    let found: string | null = null;
    for (const variant of nameVariants(name)) {
      // An unknown name can come back as 404 rather than an empty list.
      const xml = await this.get(`/station/${encodeURIComponent(variant)}`, { notFoundIsEmpty: true });
      for (const tag of xml.matchAll(/<station\s[^>]*\/?>/g)) {
        const a = attrs(tag[0]);
        if (a.eva && a.name && comparable(a.name) === comparable(variant)) {
          found = a.eva;
          break;
        }
      }
      if (found) break;
    }
    this.stationIds.set(name, found);
    return found;
  }

  /**
   * Notices for one train at one station. `trainNumber` is the run number
   * ("107", "26814"); `plannedTime` (ISO) picks the right run if several match.
   * An empty list means DB published nothing for this train there.
   */
  async getNoticesForTrain(
    stationName: string,
    trainNumber: string,
    plannedTime?: string,
  ): Promise<{ station: string; notices: Notice[] } | null> {
    const eva = await this.findStationEva(stationName);
    if (!eva) return null;
    const number = trainNumber.replace(/^0+/, "");
    const wanted = isoToDbTime(plannedTime ?? new Date().toISOString());
    const pick = (stops: RawStop[]) => {
      const candidates = stops.filter((s) => s.number === number);
      return candidates.find((s) => s.plannedTimes.includes(wanted)) ?? candidates[0];
    };

    // The changes feed mostly omits train numbers, so find the run's id in
    // the planned timetable for that hour, then its notices in the changes.
    const [changes, planned] = await Promise.all([
      this.board(eva),
      this.plan(eva, wanted.slice(0, 6), wanted.slice(6, 8)),
    ]);
    const run = pick(planned) ?? pick(changes);
    const changed = run ? changes.find((s) => s.id === run.id) : undefined;
    return { station: stationName, notices: changed ? currentNotices(changed.messages) : [] };
  }

  private async plan(eva: string, day: string, hour: string): Promise<RawStop[]> {
    const key = `${eva}/${day}/${hour}`;
    const cached = this.plans.get(key);
    if (cached && Date.now() - cached.at < PLAN_CACHE_MS) return cached.stops;
    const stops = parseBoard(await this.get(`/plan/${eva}/${day}/${hour}`));
    this.plans.set(key, { at: Date.now(), stops });
    return stops;
  }

  private async board(eva: string): Promise<RawStop[]> {
    const cached = this.boards.get(eva);
    if (cached && Date.now() - cached.at < BOARD_CACHE_MS) return cached.stops;
    // fchg: every known change for the station, which is where notices live.
    const stops = parseBoard(await this.get(`/fchg/${eva}`));
    this.boards.set(eva, { at: Date.now(), stops });
    return stops;
  }

  private async get(path: string, opts: { notFoundIsEmpty?: boolean } = {}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        signal: controller.signal,
        headers: { "DB-Client-Id": this.clientId, "DB-Api-Key": this.apiKey, Accept: "application/xml" },
      });
      const body = await res.text();
      if (res.status === 401) {
        throw new ProviderError("DB API rejected the key (check DB_CLIENT_ID and DB_API_KEY)", "db", "http");
      }
      if (res.status === 403) {
        const notSubscribed = /Not registered to plan/i.test(body);
        throw new ProviderError(
          notSubscribed
            ? "DB API key works but is not subscribed to the Timetables API (subscribe to the Free plan in the DB API Marketplace)"
            : "DB API refused the request (HTTP 403)",
          "db",
          "http",
        );
      }
      if (res.status === 404 && opts.notFoundIsEmpty) return "";
      if (!res.ok) throw new ProviderError(`DB API ${path.split("/")[1]} returned HTTP ${res.status}`, "db", "http");
      return body;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderError(`DB API timed out after ${this.timeoutMs}ms`, "db", "timeout");
      }
      throw new ProviderError(`DB API request failed: ${(err as Error).message}`, "db", "http", err);
    } finally {
      clearTimeout(timer);
    }
  }
}
