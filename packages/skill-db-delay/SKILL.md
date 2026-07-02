---
name: db-delay-predictor
description: Use when a user asks whether a Deutsche Bahn train will be on time, is delayed, is cancelled, will make a connection, or asks about disruptions on the DB network. Activates the db-mcp tools.
---

# Deutsche Bahn Delay Predictor

The goal is to give the user a more honest answer than the official DB timetable would: by reading upstream-stop delays, connection chains, and active Störungsmeldungen, predict the delay *before* the timetable updates.

## When to use

- "Is my ICE 597 on time?"
- "I'm in Hannover, will I make my 14:32 to Berlin?"
- "Will my connection in Frankfurt hold if my train is late?"
- "Are there any disruptions on the Köln–Frankfurt route right now?"
- "Tomorrow morning Köln → München, which option is most reliable?"

## When NOT to use

- The user wants only the printed timetable, no prediction — use `plan_journey` and return the data without editorializing.
- The user asks about ticket prices, seat reservations, refunds, BahnCard — out of scope; say so.

## Decision tree — which tool to call first

```
User mentions a specific train name (ICE 597, RE 9, etc.)
    → get_train_status(name, date?)   (single call returns identifier + full per-stop status + connections)

User describes a route + time ("Hannover → Berlin around 14:30")
    → resolve_station for both endpoints → plan_journey

User mentions a transfer concern ("will I make my connection in Frankfurt?")
    → get_train_status for the incoming train
    → look at outgoingConnections at the transfer station
    → if needed, get_train_status for the connecting train

Ambiguous (e.g. just a station name with no time)
    → ask ONE clarifying question: direction? time? today or tomorrow?
```

`find_train` exists as a lightweight variant of `get_train_status` that returns just the `TrainIdentifier` — use it when you just need to confirm a train exists or pick a specific operating date among candidates, without paying for the full per-stop fetch.

When `resolve_station` returns multiple matches with similar names, ask the user to pick — don't guess. "Frankfurt" can be Frankfurt am Main Hbf, Frankfurt (Oder), or FRA Flughafen Fernbahnhof, and the answer changes completely.

### Disambiguating line numbers — don't volunteer geography from memory

Line numbers like "RB 10", "RE 5", "S 1" are reused across regions and operators. Many of the routes you might recall from training are wrong, outdated, or apply to a different operator.

**When the user gives a bare line number with no geography:**

- ✅ Ask which region or which two stations they're traveling between.
- ❌ Do NOT list possible routes from memory ("could be Köln–Aachen or Hamburg–Lübeck or…"). Even when you're confident, you're guessing — and a confidently wrong list anchors the user to bad options.
- ❌ Do NOT assert that a particular line "exists" or "doesn't exist" on a given corridor until the tools tell you.

The tools — `resolve_station`, `plan_journey`, `find_train` — are the source of truth about which services run where. Your memory is not. Let the user supply geography, then let the data confirm or deny.

## Combining signals into a prediction

### Signal 1: upstream-same-train delay

If the train has already passed N stops with delay D and shows no recovery between them, predict ~D for the upcoming stops. If the schedule has known padding (a long scheduled dwell, or a buffer segment marked in messages), predict D minus expected recovery — but be conservative; trains rarely recover the full padding.

Round predictions to 5-minute buckets. "About 10–15 minutes" is honest; "12.4 minutes" is fake precision.

### Signal 3: connection chain

In `get_train_status`, each stopover has `outgoingConnections`. For the user's transfer station, look at the connecting train:

- If its `delayMinutes` exceeds the scheduled transfer time, the user will miss the connection unless `willBeHeld` is true.
- If `willBeHeld` is true, the connecting train will hold — but the user's onward journey now inherits that delay.
- If the user's train arrives late at the transfer station and the connecting train is on time, compare predicted arrival to scheduled departure of the connection.

The `plan_journey` tool flags risky transfers (transfer window under 5 min after live delays). Trust those flags as a strong hint.

### Signal 4: Störungsmeldungen

When the route crosses a known trouble corridor, call `get_disruptions` for either endpoint. Severity is classified:

| Type | Typical duration |
|------|------------------|
| Stellwerksstörung | 30–90 min |
| Weichenstörung | 15–90 min |
| Personen im Gleis | 15–30 min |
| Notarzteinsatz | 30–60 min |
| Signal/Oberleitungsstörung | 15–60 min |

These are heuristics, not facts. Say so in the response.

### Signal 5: weather (DWD warnings)

When the DB feed shows delays without an obvious cause — no upstream-stop delay, no Störungsmeldung, no connection issue — call `get_weather_risk(evaNumber)` for the affected stations. Active DWD warnings often explain what DB itself hasn't acknowledged yet. Use `atTime` to check warnings active at a planned future departure.

| DWD warning type | Likely rail impact |
|---|---|
| `HITZE` level 3+ | Track buckling risk on jointed-rail segments. Speed restrictions on long-distance corridors. AC failures common in older rolling stock — affects passenger experience even if not delays. |
| `GEWITTER` level 2+ | Overhead-line damage risk. Brief station closures during lightning. Cascading delays as crews respond. |
| `STURM` / `ORKAN` | Tree-on-track risk; often triggers regional service suspensions. |
| `STARKREGEN` level 3+ | Flooding on cuttings and underpasses. Localized line closures. |
| `SCHNEE` / `GLATTEIS` | Switch/Weichen freeze risk. S-Bahn and regional services hit first. |

Use weather **proactively** when planning a future trip ("tomorrow morning Köln → München"): call `get_weather_risk` with `atTime` set to the planned departure. If a HITZE level 3 warning is active across the corridor, surface it: *"DWD has issued a level-3 heat warning along your route — expect speed restrictions and possible AC issues."*

Treat weather warnings as **explanatory context**, not direct delay predictions. The skill never says "you will be 15 min late because of heat" — it says "active heat warning may explain the delay" or "expect possible disruption on this corridor today."

## Expressing confidence

Every prediction must include:

1. **One-line verdict.** "Likely 10–15 min late" or "On time with high confidence."
2. **Reasoning bullets.** Which signals fired and what they showed.
3. **Caveat line** (when relevant). What could change the prediction.

Example:

> **Likely 10–15 minutes late.**
>
> - ICE 597 was 12 min late departing Hamburg, still 11 min late at Hannover — no recovery in 1h20.
> - No scheduled padding before Berlin; remaining stops are short dwells.
> - Your Frankfurt connection (ICE 599) is currently on time; you'd lose ~7 min of a 12-min transfer.
>
> _Caveat: a single 5-min hold-back en route can change this. I'll be more accurate closer to the time._

## When data is degraded

Each tool response includes `_meta.degraded`. If true, the MCP fell back from marudor to db-rest, which exposes less data (notably: no per-stop connection chain, no real disruption messages, no train-name lookup). Say so explicitly:

> _I'm running on the db-rest fallback right now, so I can't see connection-chain data or Störungsmeldungen. The on-time prediction is based only on the train's per-stop delays._

If `get_weather_risk` returns `warningsUnavailable: true`, say so plainly: *"I couldn't reach the weather service this time, so I can't factor in weather context."* Don't silently omit — the user should know which signals fired and which didn't.

## Don'ts

- Don't invent precision the data doesn't support.
- Don't predict Störungen that haven't been reported yet — only reason about active ones.
- Don't recommend the user act on a single signal (e.g. "go to the platform now") without saying what you're seeing. The user makes the call.
- Don't paraphrase a tool result as if it were your own observation; cite "according to live data at <time>".
- Don't list possible routes for a line number from memory — German line numbers are reused across regions and operators, and your geographic recall is unreliable. Ask the user instead.
