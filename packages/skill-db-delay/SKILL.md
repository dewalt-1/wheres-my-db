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
    → resolve_station → find_train(name, stationId)
    → get_train_status(tripId, boardLat, boardLon) with the coordinates of the
      station where the user boards, so their stop is marked
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

## Every answer shows the diagram

`get_train_status` and `get_late_trains` return a text diagram (● passed stop, ○ stop ahead, ▼ or ▶ where the train is, lines and arrows between stops). Put it in your reply every time, unchanged, inside a code block, right after your verdict and reasons. It is part of the answer, not debug output: never drop it to keep a reply short, and never redraw or summarise it.

## Combining signals into a prediction

### Signal 1: delay already built up on this train

`get_train_status` gives the arrival delay at every stop. If the train is D minutes late at the stops it has passed and the delay is not shrinking, predict about D for the stops ahead. If the delay has been growing stop by stop, say so; it rarely reverses quickly. Trains do recover a few minutes on long non-stop stretches, so be conservative in both directions.

Round to 5-minute buckets. "About 10–15 minutes" is honest; "12.4 minutes" is fake precision.

### Signal 1b: the line ahead (the main added value)

`get_train_status` returns `lineAhead`: the user's train checked against the other trains ahead of it on its route. Trains can't overtake between two stops, so if a train ahead is held or slow on a stretch the user's train still has to pass, the user's train will be later than the official prediction says. This works without any DB key.

- `held-up`: lead your answer with it, in this shape: **"Officially 5 min late at Köln Hbf; RE 5 ahead is held near Bonn, so expect about 15–20 min late."** The diagram already contains this line. Use `estimatedDelayMinutes` as your verdict and say the official figure too, so the user sees what you added.
  - `confidence: "possible"` means the train ahead may run on separate tracks (an S-Bahn ahead of a mainline train, or the reverse). Say "may be held up" rather than "will be".
  - Never state it as certain. It assumes no recovery after the hold-up and standard gaps between trains.
- `clear`: trains ahead were checked and none holds the train up. You can say so in a few words ("nothing ahead is holding it up"); it supports an on-time verdict.
- `not-checked`: say nothing about it.

### Signal 2: the transfer window

Compare the predicted arrival of the incoming train with the predicted departure of the connecting one, both from live data. `plan_journey` does this for you and lists `riskyTransfers` (under 5 minutes between trains). Allow extra time when the trains use different platforms or the option contains a walking leg.

You cannot see whether a connecting train will be held for late passengers. Never promise that it will wait.

### Signal 3: platform, cancellations, alerts

Tell the user the current platform (`track`) at their stop. Do not claim a platform *change* from `scheduledTrack`: that field often holds an internal code, not the planned platform. `cancelled: true` on a stop or a whole trip ends the question; move straight to alternatives with `plan_journey`. If `alerts` is non-empty, quote the alert text; if it is empty, that only means no alert was published, not that nothing is wrong.

### Signal 3b: DB notices at the user's stop

When a DB API key is configured, `get_train_status` (called with `boardLat`/`boardLon`) returns `boardingNotices` for the user's boarding stop:

- `delay-reason` notices say *why* a train is late ("Repair to a signal", "Delay from its previous journey"). Use them in your reasoning; quote the most recent one or two.
- `quality` notices are the small things that affect the trip ("No food or drink available", "Several coaches missing", "Bikes not allowed", "Train very busy"). Mention them when they matter for this user, even if the train is on time.
- `disruption` notices name a published disruption (e.g. construction work). Treat them like alerts: context, not a delay prediction.

The diagram already lists them under "DB notices at …". Statuses other than `ok`:

- `off`: no DB key is configured. Don't mention DB notices unless the user asks about delay reasons, catering or coaches; then say they can be added with a free DB API key (README, "Using the DB API"). Never ask the user to paste a key into the chat; point them to the terminal command `npm run setup-db-api`.
- `not-covered`: trams, U-Bahn and buses; DB publishes no notices for them. Say nothing about it.
- `station-not-found` or `error`: say DB's notices couldn't be loaded this time, in one short clause, and carry on.

### Signal 4: what's happening around the train

If an entry in `get_late_trains` says `feedsDisagree`, two data sources report that train with clearly different delays or positions (common for trains crossing the border). Say the sources disagree; don't build an explanation on either one.

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

## The live view

`get_train_status` and `get_late_trains` return a second text block: a ready-made, metro-style diagram (● passed stop, ○ stop ahead, ▼ or ▶ where the train is now), followed by a `Live map:` link.

**When the user asks about their train:**

1. Answer the question first: the verdict, the reasoning, and the text diagram.
2. Then ask, in one short line: *"Want a live view of your train?"*
3. Only if they say yes, give the `Live map:` link from that train's `get_train_status` result. It opens a map of *their train*: the whole route, where the train is now, and their boarding stop marked with the delay there. It is not a map of the station or the area.

Always pass `boardLat` and `boardLon` to `get_train_status` when you know where the user boards; without them the map and diagram cannot mark their stop.

**When the user asks about an area** ("what's late around Köln?"), show the diagram from `get_late_trains` and give its link straight away; that link is the area map.

**Rules for both**

- Show the diagram exactly as received, inside a code block so the columns line up, in every answer that called these tools. Do not redraw, reorder, summarise or leave it out.
- Copy the link exactly; never build or edit one yourself, and never substitute the area link for a train link.
- Don't offer the live view again in the same conversation once the user has declined or already has the link.

## Watch mode: keeping the user posted

When the user asks you to watch a train or a journey ("keep me posted", "tell me if anything changes", "watch my connection"):

**How you can do it depends on where you are running.** Use whatever your environment already offers for running a task again later and for messaging the user: a scheduled or recurring task, a loop, a reminder, and the chat or messaging channel the user is already talking to you on. If you have no way to act again on your own, say so plainly and offer to re-check whenever they ask. Never promise updates you cannot send.

**Set up**

1. Pin down what to watch: the `tripId` of each train, the station where the user boards, and each transfer station. Resolve these now, while the user is here to answer questions.
2. Take a baseline with `get_train_status` and tell the user the current state and that you'll message only when something changes.
3. Remember the last values you reported: delay at the user's boarding stop and at each transfer, platforms, cancellations.

**Each check**

- Call `get_train_status` for each watched train. For a transfer, compare predicted arrival with the next train's predicted departure.
- Check about every 5 minutes; every 2 minutes in the 15 minutes before the user boards or changes trains.

**Message the user only when one of these happens**

- The delay at their stop crosses 5, 10, 20, 30 or 60 minutes, in either direction.
- The platform at their stop is different from the one you last reported.
- A train or their stop is cancelled.
- A transfer drops under 5 minutes, becomes impossible, or becomes comfortable again.
- Live data disappears (`realTime` turns false) or a check fails twice in a row.

Otherwise stay silent. A message every few minutes saying "no change" is noise.

**Message format:** one or two lines, the change first. Example: *"ICE 107 is now about 40 min late into Köln (was 25). Now on platform 6 (was 4 at my last check). Your S9 in Frankfurt still works, 17 min to change."* Add the map link when the delay is new or has jumped.

**Stop** when the user arrives, the last watched train has passed their final stop, the user says stop, or the run is cancelled (report that, suggest alternatives with `plan_journey`, then stop). Tell the user when you stop.

## Expressing confidence

Every prediction includes:

1. **One-line verdict.** "Likely 10–15 min late" or "On time so far."
2. **Reasoning bullets.** Which signals you used and what they showed.
3. **Caveat** when relevant: what could change it.

Example:

> **Likely 15–20 minutes late into Köln (officially 5).**
>
> - RE 5 is held just ahead of your train near Bonn, and trains can't overtake there, so yours can't arrive before it clears.
> - Your train itself has been on time so far.
>
> _If the RE 5 gets moving soon, this shrinks; the official figure doesn't yet account for it._
>
> ```
> RE 1 → Aachen Hbf  (live)
>  ●  Bonn Hbf                       18:02  +5 min
>  ▼  train is around here
>  ○  Köln Hbf                       18:24  +5 min   platform 5, ← you board here
>  ○  Aachen Hbf                     19:10  +4 min
> Officially 5 min late at Köln Hbf; RE 5 ahead is held near Bonn, so expect about 15–20 min late.
> ```
>
> Want a live view of your train?

Another example:

> **Likely 35–40 minutes late into Köln.**
>
> - ICE 107 reached Dortmund 10 min late and Düsseldorf 25 min late; the delay is growing, not recovering.
> - It is currently shown on platform 6 at Köln.
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
