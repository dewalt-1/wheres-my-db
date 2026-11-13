---
name: db-delay-predictor
description: Use when a user asks whether a train in Germany (ICE, IC, regional, S-Bahn, U-Bahn, tram) will be on time, is delayed or cancelled, whether they will make a connection, which trains are late or stuck in an area, or how weather affects a trip. Activates the db-mcp tools.
---

# Deutsche Bahn Delay Predictor

The goal is a more useful answer than the departure board gives: read the delay a train has already built up at earlier stops, check the user's transfers against live times, and say how the delay affects *their* trip.

## When to use

- "Is ICE 597 on time?"
- "I'm in Hannover, will I make my 14:32 to Berlin?"
- "Will I make my connection in Frankfurt?"
- "Which trains around Köln are late right now?"
- "Tomorrow morning Köln → München, which option is most reliable?"

## When NOT to use

- The user wants only the timetable, no prediction: use `plan_journey` or `get_departures` and return the data without commentary.
- Ticket prices, seat reservations, refunds, BahnCard: out of scope; say so.

## Tools

| Tool | Use it for |
|---|---|
| `resolve_station(query)` | Name → station `id` and coordinates. Always the first step. |
| `get_departures(stationId, time?, limit?)` | Live departure board of a station. |
| `find_train(name, stationId, time?)` | A named train or line on that station's board → `tripId`. |
| `get_train_status(tripId)` | Every stop of one run with arrival/departure delay and platform. |
| `plan_journey(fromStationId, toStationId, time?)` | Route options with live delays and flagged risky transfers. |
| `get_late_trains(lat, lon, radiusKm?, minDelayMinutes?)` | Late and likely-stuck trains around a point. |
| `get_weather_risk(lat, lon, atTime?)` | Official DWD weather warnings for that location. |

Station ids and trip ids are opaque: pass them back exactly as received.

## Decision tree

```
User names a train or line ("ICE 597", "RE1", "S19")
    → there is no lookup by train name alone, so you need a station it calls at.
      If the user gave none, ask where they board.
    → resolve_station → find_train(name, stationId) → get_train_status(tripId)
    → a line like "S19" returns several runs: pick by time and direction, or ask.

User describes a route ("Hannover → Berlin around 14:30")
    → resolve_station for both ends → plan_journey

User worries about a transfer ("will I make my connection in Frankfurt?")
    → get_train_status for the incoming train: predicted arrival at the transfer station
    → find_train / get_departures at the transfer station: predicted departure of the next train
    → compare the two live times

User asks about an area ("what's late around Köln?")
    → resolve_station → get_late_trains(lat, lon)

Ambiguous (a station with no time or direction)
    → ask ONE clarifying question: direction? time? today or tomorrow?
```

When `resolve_station` returns several similar names, ask the user to pick. "Frankfurt" can be Frankfurt (Main) Hbf, Frankfurt (Oder) or the airport station, and the answer changes completely.

### Don't volunteer geography from memory

Line numbers like "RB 10", "RE 5", "S 1" are reused across regions and operators, and routes you recall may be wrong or outdated.

- ✅ Ask which station they board at, or which two stations they travel between.
- ❌ Do NOT list possible routes from memory ("could be Köln–Aachen or Hamburg–Lübeck…").
- ❌ Do NOT say a line exists or doesn't exist on a corridor until the tools tell you.

## Combining signals into a prediction

### Signal 1: delay already built up on this train

`get_train_status` gives the arrival delay at every stop. If the train is D minutes late at the stops it has passed and the delay is not shrinking, predict about D for the stops ahead. If the delay has been growing stop by stop, say so; it rarely reverses quickly. Trains do recover a few minutes on long non-stop stretches, so be conservative in both directions.

Round to 5-minute buckets. "About 10–15 minutes" is honest; "12.4 minutes" is fake precision.

### Signal 2: the transfer window

Compare the predicted arrival of the incoming train with the predicted departure of the connecting one, both from live data. `plan_journey` does this for you and lists `riskyTransfers` (under 5 minutes between trains). Allow extra time when the trains use different platforms or the option contains a walking leg.

You cannot see whether a connecting train will be held for late passengers. Never promise that it will wait.

### Signal 3: platform changes, cancellations, alerts

`track` different from `scheduledTrack` means a platform change: mention it. `cancelled: true` on a stop or a whole trip ends the question; move straight to alternatives with `plan_journey`. If `alerts` is non-empty, quote the alert text; if it is empty, that only means no alert was published, not that nothing is wrong.

### Signal 4: what's happening around the train

When one train is badly delayed, `get_late_trains` around its current area shows whether it is alone or part of a wider problem. Many late trains on one corridor suggests a line disruption and makes recovery unlikely. `likelyStuck: true` means a train is losing 10+ minutes between two stops right now; describe it as "appears to be held or crawling", never as a confirmed standstill.

### Signal 5: weather (DWD warnings)

Call `get_weather_risk` with the coordinates of the affected station when delays have no visible cause, or with `atTime` set to the planned departure for a future trip.

| Warning (examples of `type`) | Likely rail impact |
|---|---|
| HITZE, level 3+ | Speed restrictions, air-conditioning failures in older trains. |
| GEWITTER, level 2+ | Overhead-line damage, short station closures, knock-on delays. |
| STURM, ORKAN, STURMBÖEN level 2+ | Trees on the line; regional services may be suspended. |
| STARKREGEN, level 3+ | Flooded cuttings and underpasses, local line closures. |
| SCHNEE, GLATTEIS, FROST level 2+ | Frozen points; S-Bahn and regional services hit first. |

Weather is context, not a delay prediction. Say "an active storm warning may explain this" or "expect possible disruption on this corridor", never "you will be 15 minutes late because of heat". Level 1 warnings (e.g. light frost) rarely affect trains; don't alarm the user over them.

## Showing a map

For "show me" questions about an area, call `get_late_trains` and present the result as a short list first (worst delays, then likely-stuck trains, each with the two stops it is between). Each train comes with coordinates so the result can be drawn on a map where the client supports it.

## Expressing confidence

Every prediction includes:

1. **One-line verdict.** "Likely 10–15 min late" or "On time so far."
2. **Reasoning bullets.** Which signals you used and what they showed.
3. **Caveat** when relevant: what could change it.

Example:

> **Likely 35–40 minutes late into Köln.**
>
> - ICE 107 reached Dortmund 10 min late and Düsseldorf 25 min late; the delay is growing, not recovering.
> - It is now using platform 6 at Köln instead of the scheduled one.
> - Your S9 in Frankfurt leaves 17 minutes after the predicted arrival, so that transfer still works.
>
> _Based on live data a minute ago; this can shift before you board._

## When data is missing

- `realTime: false` on a departure, leg or trip means timetable times only. Say so: *"I only have the timetable for this one, no live data, so I can't tell you whether it's late."* Do not report it as on time.
- If a tool call fails, say which lookup failed and what you can still tell the user. Don't retry more than once.
- If `get_weather_risk` returns `warningsUnavailable: true`, say you couldn't reach the weather service; don't imply there are no warnings.

## Don'ts

- Don't invent precision the data doesn't support.
- Don't promise a connection will be held.
- Don't predict disruptions that haven't been reported.
- Don't tell the user what to do on a single signal without saying what you're seeing. They make the call.
- Don't present a tool result as your own observation; say it is live data and roughly how fresh.
- Don't list possible routes for a line number from memory. Ask the user.
