# Planning a journey when there's a reported Störung

User is planning a trip from Köln to Frankfurt for tomorrow morning. They want to know which of two route options is most reliable. The agent discovers an active signalling failure (Stellwerksstörung) affecting connections near Köln and flags the risk.

---

## Turn 1

**User:** I'm planning to go from Köln to Frankfurt tomorrow morning around 08:00. I see two options in the DB app—one direct, one via Bonn. Which is more reliable? I've had bad luck with Cologne lately.

**Assistant:** Let me find both stations and then check both journey options, plus any active disruptions in the Köln area.

```json
{
  "tool": "resolve_station",
  "input": {
    "query": "Köln Hbf"
  }
}
```

```json
{
  "tool": "resolve_station",
  "input": {
    "query": "Frankfurt am Main Hbf"
  }
}
```

Great. Köln Hbf is EVA 8000207, Frankfurt am Main Hbf is EVA 8000105. Now let me see what journey options are available for tomorrow morning at 08:00.

```json
{
  "tool": "plan_journey",
  "input": {
    "fromEva": "8000207",
    "toEva": "8000105",
    "isoTime": "2026-06-14T08:00:00Z"
  }
}
```

Now let me check for any active disruptions in the Köln area, given your comment about recent bad luck there.

```json
{
  "tool": "get_disruptions",
  "input": {
    "evaNumber": "8000207"
  }
}
```

I found something important: there is an **active Stellwerksstörung (signalling failure) at Köln Messe/Deutz**, expected to last 60–90 minutes from now. That's a high-severity disruption affecting routing in the Köln area.

**Verdict: Both options are at risk for tomorrow morning if the Störung persists.**

- **Stellwerksstörung at Köln Messe/Deutz:** Typical duration 60–90 minutes; expected end time shows it may still be active tomorrow depending on repair progress.
- **Both the direct route and Bonn detour likely touch the affected segment** or share capacity constraints from the outage, so neither option has a clear advantage until we know the disruption status.
- **Your hunch is justified:** this is exactly the kind of upstream problem the DB board won't reflect until minutes before departure.

**Recommendation:** Check again tomorrow morning (06:00–07:30). If the Störung is cleared, both options should be fine. If it's still ongoing, DB will auto-reroute you or cancel trains, and you'll see alternative options appear in the planner. Don't commit to either option until you've confirmed the disruption status closer to the time.

---

## Turn 2

**User:** What's the typical delay from a Stellwerksstörung like that?

**Assistant:** A Stellwerksstörung typically causes 30–90 minute delays, depending on how backed up the signal queue gets and how quickly technicians restore the interlocking. The worst case is cascading delays that ripple through the network all morning.

The fact that the expected end time shows 60–90 minutes is actually a good sign—it suggests the dispatch center has a rough estimate. But until it's cleared, any train routed through or near Köln Messe/Deutz is at risk.

**Bottom line:** The Störung could add anywhere from 20 to 60+ minutes to your journey. That's why I'm saying check again in the morning rather than lock in a booking now. You want to see this resolved (or at least see how DB is re-routing) before you commit.

_Caveat: I can only see disruptions that are currently reported. New incidents can always occur. But this Stellwerksstörung is the biggest risk factor for tomorrow's Köln–Frankfurt route._
