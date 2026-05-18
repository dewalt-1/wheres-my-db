# Marudor (bahn.expert) API — observed contracts

Date probed: 2026-05-18

## Architecture overview

The live service at `https://bahn.expert` is **not** a plain REST API. It runs a
[tRPC v11](https://trpc.io/) server with a custom [devalue](https://github.com/Rich-Harris/devalue)
transformer. All endpoints use the same transport:

- **Base URL**: `https://bahn.expert/rpc`
- **Protocol**: tRPC v11 — query procedures use **GET**, mutations use POST (none relevant here)
- **Input encoding**: `?input=<double-JSON-encoded devalue array>` (see below)
- **Output encoding**: `{"result":{"data":"<devalue-stringified JSON string>"}}`

The `/api` base (which was guessed in the task prompt) routes to a
`trpc-to-openapi` OpenAPI handler, but only **3 procedures** have OpenAPI metadata,
and in practice they all returned 404 during probing — the live server appears to be
running a newer, private version of the codebase that does not expose them.
**All working calls were made via `/rpc`.**

### Input encoding recipe

```
devalue_str  = devalue.stringify(inputObject)  → a JSON array string
url_param    = JSON.stringify(devalue_str)      → a JSON string-of-string
URL          = /rpc/<router>.<procedure>?input=<url-encoded url_param>
```

For simple objects where all values are strings/numbers, devalue produces a flat array
where index 0 is the root object (with integer refs to other indices), and subsequent
elements are the referenced values. Booleans and `null`/`-1` (= null in devalue) are
stored by reference too.

**Example — stopPlace.byTerm input `{searchTerm: "Köln Hbf"}`:**
```
devalue flat array: [{"searchTerm":1},"Köln Hbf"]
JSON.stringify of that string: "[{\"searchTerm\":1},\"Köln Hbf\"]"
URL param: input=%22%5B%7B%22searchTerm%22%3A1%7D%2C%22K%C3%B6ln%20Hbf%22%5D%22
```

**Example — bahn.routing with nested objects and boolean:**
```
devalue flat array: [{"start":1,"destination":4,"searchForDeparture":6,"time":7,...},
                     {"type":2,"evaNumber":3},"stopPlace","8000207",
                     {"type":2,"evaNumber":5},"8098160",
                     true, ["Date","2026-05-18T10:00:00.000Z"]]
```
Key rules:
- Duplicate string values share the same index (deduplication).
- `true`/`false` are stored at their own index (not as literal booleans inside objects).
- Dates are encoded as `["Date","<ISO 8601 string>"]` at their index.
- `null` values are represented as `-1` in the flat array; in the object they appear
  as `-1` integer references.

### Decoding responses

Responses carry the same devalue encoding: `result.data` is a JSON string of the
devalue-flattened output. Callers must run `JSON.parse(response.result.data)` →
`devalue.unflatten(parsed)` to get the real object. In practice the devalue
encoding only matters for Dates (which arrive as `["Date","ISO"]` entries); a
simpler approach is to call `JSON.parse` on each flat array element and do index
substitution yourself (see the fixture-generation Python script in the task).

---

## 1. Station search

**Procedure**: `stopPlace.byTerm`
**URL pattern**: `GET https://bahn.expert/rpc/stopPlace.byTerm?input=<encoded>`
**Input schema**:
```typescript
{ searchTerm: string; max?: number; filterForIris?: boolean }
```
**Example URL** (decoded input):
```
input = "[{\"searchTerm\":1},\"Köln Hbf\"]"
```

**Response shape**: array of stop-place objects.

```json
[
  {
    "evaNumber": "8000207",
    "name": "Köln Hbf",
    "availableTransports": [
      "HIGH_SPEED_TRAIN", "INTERCITY_TRAIN", "INTER_REGIONAL_TRAIN",
      "REGIONAL_TRAIN", "CITY_TRAIN"
    ],
    "position": { "longitude": 6.958729, "latitude": 50.94303 },
    "alternativeRil100": ["KK  S", "KK  F"],
    "ifopt": "de:05315:11201",
    "ril100": "KK",
    "stationId": "3320"
  }
]
```

**Maps to our `Station[]`**:
- `evaNumber` → `evaNumber`
- `name` → `name`
- `position.latitude` / `position.longitude` → coordinates
- `availableTransports` → transport type filter

**Notes**:
- Also available: `stopPlace.byKey` — takes a single string (EVA number or Rl100 code).
- Also available: `stopPlace.name` and `stopPlace.evaNumber` — exact-match lookups.
- The response includes tram/bus stops mixed with train stations; filter by
  `availableTransports` containing `HIGH_SPEED_TRAIN` / `INTERCITY_TRAIN` / etc. for
  long-distance train stations.
- `stationId` is the DB Station & Service ID; null for non-DB stops.

**Discrepancy from original plan**: The task spec guessed
`GET /api/stopPlace/v1/search/{name}` — that path does not exist. The actual
procedure is `stopPlace.byTerm` on the tRPC interface.

---

## 2. Train details

**Step 1 — find the journey ID**: `journey.find`
**URL pattern**: `GET https://bahn.expert/rpc/journey.find?input=<encoded>`
**Input schema**:
```typescript
{
  journeyNumber: number;   // e.g. 597
  date: Date;              // encoded as ["Date","ISO"]
  category?: string;       // e.g. "ICE"
  administration?: string; // e.g. "80" for DB Fernverkehr
}
```
**Response**: array of journey candidates, each with:
```json
{
  "journeyId": "20260518-589dd5e9-6c97-3e24-9eb8-9d9f8871de73",
  "train": { "line": null, "category": "ICE", "journeyNumber": 597,
             "transportType": "HIGH_SPEED_TRAIN" },
  "stops": [],
  "firstStop": { "stopPlace": { "evaNumber": "8098160", "name": "Berlin Hbf" } },
  "lastStop":  { "stopPlace": { "evaNumber": "8000261", "name": "München Hbf" } }
}
```

**Step 2 — get per-stop details**: `journey.detailsByJourneyId`
**URL pattern**: `GET https://bahn.expert/rpc/journey.detailsByJourneyId?input=<encoded>`
**Input**: a single string — the `journeyId` from step 1.
**Input encoding** (devalue for string `"20260518-..."`):
```
"[\"20260518-589dd5e9-6c97-3e24-9eb8-9d9f8871de73\"]"
```

**Response shape** (top-level):
```json
{
  "stops": [...],
  "segmentStart": { "evaNumber": "...", "name": "...", "ril100": "..." },
  "segmentDestination": { ... },
  "journeyId": "20260518-...",
  "arrival": { ... },
  "departure": { ... },
  "finalDestination": "München Hbf",
  "train": {
    "category": "ICE",
    "journeyNumber": 597,
    "admin": "80",
    "line": null,
    "customLine": "11",
    "transportType": "HIGH_SPEED_TRAIN",
    "operator": "DB Fernverkehr AG",
    "name": "ICE 597"
  },
  "type": "JNY",
  "cancelled": null,
  "continuationFor": null,
  "continuationBy": null,
  "lastKnownPosition": "...",
  "currentStop": null
}
```

**Per-stop structure** (`stops[]` element):
```json
{
  "stopPlace": {
    "evaNumber": "8011113",
    "name": "Berlin Südkreuz",
    "ril100": "BPAF"
  },
  "arrival": {
    "scheduledTime": "2026-05-18T07:33:00.000Z",
    "time": "2026-05-18T07:31:14.000Z",
    "cancelled": null,
    "additional": null,
    "delay": -2,
    "scheduledPlatform": "5",
    "platform": "5",
    "isRealTime": true,
    "noPassengerChange": true,
    "codeShares": null,
    "id": "8011113_A_1"
  },
  "departure": {
    "scheduledTime": "2026-05-18T07:35:00.000Z",
    "time": "2026-05-18T07:35:32.000Z",
    "cancelled": null,
    "additional": null,
    "delay": 0,
    "scheduledPlatform": "5",
    "platform": "5",
    "isRealTime": true,
    "noPassengerChange": null,
    "codeShares": null,
    "id": "8011113_D_1"
  },
  "codeShares": null
}
```

**Maps to our `TrainStatus`**:
- `stops[].stopPlace` → stop station info (`evaNumber`, `name`)
- `stops[].arrival.delay` → `arrivalDelayMinutes` (signed integer, minutes; negative = early)
- `stops[].departure.delay` → `departureDelayMinutes`
- `stops[].arrival.scheduledTime` → scheduled arrival ISO timestamp
- `stops[].arrival.time` → actual/predicted arrival ISO timestamp
- `stops[].arrival.cancelled` → per-stop arrival cancellation (null = not cancelled; `true` = cancelled)
- `stops[].departure.cancelled` → per-stop departure cancellation
- `stops[].arrival.id` / `stops[].departure.id` → stop event IDs (used to query connections)
- `result.cancelled` → whole-journey cancellation (null = not cancelled)
- `result.type` → journey type: `"JNY"` = normal journey; look for `"EV"` = replacement

**For outgoing connections at a stop**: see section 4 (connections.connections procedure).
There is no `willBeHeld` field in `journey.detailsByJourneyId`. Connection holding/status
is exposed via `connections.connections` in the `connectionStatusByPersona[].status` field
(values: `"POSSIBLE"`, `"IMPOSSIBLE"`, `"CRITICAL"`, etc.).

**Note on `journey.detailsByJid`** (also seen in bundles): this procedure takes a HAFAS
journey ID (`jid`), which is a different format (e.g., `"1|12345|0|80|18052026"`). The
underlying HAFAS API is currently blocked by Akamai BMP on the marudor backend, so
`journey.hafasId` returns HTTP 500 "Akamai BMP muss noch umgangen werden". Use
`journey.detailsByJourneyId` (RIS-based) instead.

**Discrepancy from original plan**: The task spec guessed
`GET /api/journeys/v2/details/ICE%20597`. The actual procedure is a two-step flow:
`journey.find` → `journey.detailsByJourneyId`.

---

## 3. Station departures (iris.departures)

**Procedure**: `iris.departures`
**URL pattern**: `GET https://bahn.expert/rpc/iris.departures?input=<encoded>`
**Input schema**:
```typescript
{
  evaNumber: string;        // e.g. "8000207" for Köln Hbf
  lookahead?: number;       // minutes ahead, default 150
  lookbehind?: number;      // minutes behind, default 0
  startTime?: Date;
}
```

**Response shape**:
```json
{
  "departures": [ /* array of AbfahrtEntry objects */ ],
  "lookbehind": [ /* same format, trains that already departed */ ],
  "wings": { /* map of wingId -> AbfahrtEntry */ },
  "stopPlaces": { /* map of evaNumber -> StopPlace */ },
  "strike": 0
}
```

**Per-departure structure** (abridged):
```json
{
  "o": "NXRE",
  "initialDeparture": "2026-05-18T15:35:00.000Z",
  "arrival": {
    "scheduledTime": "2026-05-18T18:18:00.000+02:00",
    "time": "2026-05-18T19:17:00.000+02:00",
    "platform": "4 A-C",
    "scheduledPlatform": "4 A-C",
    "hidden": false,
    "cancelled": false,
    "delay": 59
  },
  "departure": {
    "scheduledTime": "...", "time": "...", "delay": 58, "cancelled": false
  },
  "currentStopPlace": { "name": "Köln Hbf", "evaNumber": "8000207" },
  "scheduledDestination": "Köln Messe/Deutz",
  "destination": "Köln Messe/Deutz",
  "id": "7382006731006813311",
  "rawId": "7382006731006813311-2605181735-6",
  "mediumId": "7382006731006813311-2605181735",
  "train": {
    "name": "NX RE7",
    "journeyNumber": 17428,
    "line": "RE7",
    "category": "NX",
    "admin": "NXRE"
  },
  "cancelled": false,
  "messages": {
    "delay": [
      { "text": "Verspätung eines vorausfahrenden Zuges", "timestamp": "...", "value": 43 }
    ],
    "qos": [
      { "text": "Mehrere Wagen fehlen", "timestamp": "...", "value": 82 }
    ],
    "him": []
  },
  "route": [ { "name": "Krefeld Hbf" }, ... ]
}
```

**Notes**:
- `delay` is in **minutes**, signed integer.
- `messages.delay[].text` is the German-language delay reason (IRIS message text).
- `messages.him[]` contains official DB HIM disruption messages (often empty for IRIS).
- `messages.qos[]` contains quality-of-service messages (e.g., missing coaches).
- `strike` field: 0 = no strike, non-zero = strike affecting this station.

**Discrepancy from original plan**: The task spec guessed
`GET /api/iris/v2/abfahrten/8000207`. The actual procedure is `iris.departures`.
The response structure also differs: no nested `abfahrten` key, just
`{departures, lookbehind, wings, stopPlaces, strike}`.

---

## 4. Outgoing connections at a stop

**Procedure**: `connections.connections`
**URL pattern**: `GET https://bahn.expert/rpc/connections.connections?input=<encoded>`
**Input schema**:
```typescript
{
  journeyId: string;  // RIS journey ID (from journey.find)
  arrivalId: string;  // stop arrival event ID (stops[i].arrival.id)
  evaNumber: string;  // EVA number of the stop
}
```

**Response shape** (top-level):
```json
{
  "arrivalCanceled": false,
  "arrivalID": "8010101_A_1",
  "arrivalPlatform": "2",
  "arrivalPlatformSchedule": "2",
  "arrivalTime": "2026-05-18T11:29:12+02:00",
  "arrivalTimeSchedule": "2026-05-18T11:28:00+02:00",
  "arrivalTimeType": "REAL",
  "connections": [ /* array of connection objects */ ],
  "disruptions": [],
  "journeyID": "20260518-..."
}
```

**Per-connection structure** (abridged):
```json
{
  "additional": false,
  "canceled": false,
  "connectionSource": "CALCULATED_SCHEDULE",
  "connectionStatusByPersona": [
    { "distance": null, "duration": "PT5M", "persona": "HANDICAPPED", "status": "IMPOSSIBLE" },
    { "distance": null, "duration": "PT5M", "persona": "FREQUENT_TRAVELLER", "status": "IMPOSSIBLE" },
    { "distance": null, "duration": "PT5M", "persona": "OCCASIONAL_TRAVELLER", "status": "IMPOSSIBLE" }
  ],
  "connectionStatusByPersonaScheduled": [ ... ],
  "departureID": "645826_D_1",
  "dispositionStatus": null,
  "disruptions": [],
  "futureDisruptions": false,
  "journeyID": "20260518-04a163b2-...",
  "journeyType": "REGULAR",
  "messages": [],
  "platform": "",
  "platformHint": "DIFFERING_PLATFORM",
  "platformSchedule": "",
  "station": {
    "evaNumber": "645826",
    "ifopt": "de:16051:151196",
    "name": "Hauptbahnhof, Erfurt",
    "ril100": null
  },
  "time": "2026-05-18T11:28:00+02:00",
  "timeSchedule": "2026-05-18T11:28:00+02:00",
  "timeType": "PREVIEW",
  "transport": {
    "category": "STR",
    "destination": { "evaNumber": "...", "name": "Rieth, Erfurt" },
    "line": "STR 6",
    "journeyNumber": 1762,
    "type": "TRAM"
  }
}
```

**Maps to our connection chain**:
- `connections[].canceled` → whether the connecting train is cancelled
- `connections[].connectionStatusByPersona[].status` → `"POSSIBLE"` | `"IMPOSSIBLE"` | `"CRITICAL"`
  This is the "Anschluss wird gehalten" indicator: `"POSSIBLE"` = connection held,
  `"IMPOSSIBLE"` = connection missed/not possible, `"CRITICAL"` = at risk.
- `connections[].connectionStatusByPersonaScheduled` → same for scheduled (without real-time)
- `connections[].platformHint` → `"DIFFERING_PLATFORM"` if the connecting train is on a
  different platform than scheduled
- `connections[].futureDisruptions` → boolean, disruptions expected on the connecting train
- `connections[].transport.journeyID` = `connections[].journeyID` → RIS journeyId for the
  connecting train (can be fed back into `journey.detailsByJourneyId`)

**Note**: There is no single "willBeHeld" boolean — connection holding is indicated
per-persona via `connectionStatusByPersona[].status`. For the `OCCASIONAL_TRAVELLER`
persona, `"POSSIBLE"` = connection held, anything else = not held.

---

## 5. Journey / routing search

**Procedure**: `bahn.routing`
**URL pattern**: `GET https://bahn.expert/rpc/bahn.routing?input=<encoded>`
**Input schema**:
```typescript
{
  start: { type: "stopPlace"; evaNumber: string };
  destination: { type: "stopPlace"; evaNumber: string };
  via?: Array<{ evaNumber: string; minChangeTime?: number }>;
  time?: Date;
  transferTime?: number;
  maxChanges?: number;            // -1 = unlimited
  searchForDeparture?: boolean;   // true = depart at time, false = arrive by time
  onlyRegional?: boolean;
  klasse: "KLASSE_1" | "KLASSE_2";  // required in live version
  ctxScr?: string;                // pagination token for earlier/later results
}
```

**Note**: The live version requires `klasse`. The `lastPublic` branch code only has it as
optional, but the Zod schema in production requires it.

**Response shape**: wraps the DB Navigator routing result:
```json
{
  "routes": [ /* array of journey options */ ],
  "context": {
    "earlier": "<ctxScr token>",
    "later": "<ctxScr token>"
  }
}
```

Each route entry contains legs (segments), with train names, scheduled/actual times,
platform info, and delay data. The exact sub-shape depends on the bahn.de API response
and was not fully decoded (the backend returned `"fetch failed"` — INTERNAL_SERVER_ERROR
indicating the upstream DB Navigator API was temporarily unavailable during probing).
The request itself was accepted (Zod validation passed) before the backend failed.

**Discrepancy from original plan**: The task spec guessed
`POST /api/hafas/v4/tripSearch` with a JSON body. The actual procedure is
`bahn.routing` (GET, tRPC), the input is different (EVA numbers in `{type,evaNumber}`
wrapper objects, `klasse` required), and the backend was blocked by upstream issues
during probing. No fixture was captured for the routing response body.

---

## Common notes

### Delay encoding
- Delays are in **minutes** as signed integers.
- Negative = early (e.g., `delay: -2` = 2 minutes early).
- Zero = on time.
- `isRealTime: true` means the value is from real-time data (not estimated).

### Time fields
- `scheduledTime` — the original timetable time (ISO 8601 with timezone).
- `time` — actual or predicted time (ISO 8601 with timezone).
- `delay` = (`time` − `scheduledTime`) in minutes.
- Times from `journey.detailsByJourneyId` come as ISO strings after devalue decoding.
- Times from `iris.departures` come in `+02:00` / `+01:00` Europe/Berlin local time.

### Cancellation encoding
- In `journey.detailsByJourneyId`: `stops[i].arrival.cancelled = null` means not
  cancelled; `true` means cancelled. Same for `stops[i].departure.cancelled` and
  the top-level `result.cancelled`.
- In `iris.departures`: `departure.cancelled = false` (boolean) means not cancelled;
  `true` means cancelled. The top-level `cancelled` field on the abfahrt entry is the
  whole-train cancellation.

### EVA numbers
- 7-digit strings, e.g. `"8000207"` for Köln Hbf.
- Used as the primary station identifier throughout all endpoints.

### Procedure names found in live JS bundles
(Full inventory for Task 6 reference)
```
stopPlace.byTerm        — search by name string
stopPlace.byKey         — lookup by EVA or Rl100
stopPlace.name          — get name by EVA
stopPlace.evaNumber     — get EVA by something
stopPlace.lageplan      — station floor plan (PDF URL)
iris.departures         — IRIS real-time departure board
journey.find            — find RIS journeyId by train number + date
journey.detailsByJourneyId — full stop-by-stop details for a RIS journey
journey.detailsByJid    — same but via HAFAS jid (currently broken: Akamai BMP)
journey.ids             — list journey IDs
journey.findByCodeShare — find journey by code share
journey.hafasId         — get HAFAS jid from RIS journeyId (currently blocked)
journey.occupancy       — occupancy/Auslastung for a journey stop
journey.polyline        — geographic route polyline
journey.journeyPosition — real-time position on map
connections.connections — outgoing connections at a stop
bahn.routing            — end-to-end journey search (DB Navigator)
coachSequence.departureSequence — coach/wagon order at departure
coachSequence.arrivalSequence   — coach/wagon order at arrival
coachSequence.vehicleLayout     — vehicle interior layout
coachSequence.umlauf            — vehicle rotation plan
coachSequence.trainRuns         — train run schedule
hafas.occupancy         — occupancy via HAFAS
boards.rawDepartures    — raw RIS:Boards departure board (OpenAPI)
```

### Endpoints not found / broken
- `GET /api/stopPlace/v1/search/*` — 404, does not exist.
- `GET /api/iris/v2/abfahrten/*` — 404, does not exist.
- `GET /api/journeys/v2/details/*` — 404, does not exist.
- `POST /api/hafas/v4/tripSearch` — 404, does not exist.
- `GET /api/stopPlace/v1/messages/*` — 404, does not exist.
- `journey.hafasId` — exists but returns 500 "Akamai BMP muss noch umgangen werden".
- `bahn.routing` — exists and accepts input, but backend returned 500 "fetch failed"
  during probing (upstream DB Navigator API temporarily unavailable).

### Source reference
The last public version of the bahn.expert source is on GitHub under the `lastPublic`
branch: `https://github.com/marudor/bahn.expert/tree/lastPublic`. The live server
runs a newer private version; procedure names were verified from minified JS bundles
served by the live site.
