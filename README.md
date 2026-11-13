# Where's My DB?

*A Claude skill + MCP server that tells you **how** Deutsche Bahn delays will affect your trip — not just whether your train is late.*

---

## What it does

Knowing a train is "5 min late" isn't useful. Knowing that the 12-minute delay three stops up the line will eat your 9-minute transfer in Berlin — that's useful.

**Where's My DB?** turns *"is my train on time?"* into a real answer. You ask Claude in plain language and it walks the upstream stops, traces the connection chain, and tells you which delays actually affect *your* journey:

> **Likely 15–18 minutes late.**
> - ICE 597 was already 18 min late at Solingen Hbf (three stops upstream) at 15:42.
> - No scheduled padding before your boarding station at 16:02.
> - Your Frankfurt connection (ICE 599) is currently on time — you'd lose ~14 min of a 16-min transfer.
>
> *Caveat: a single 5-min recovery en route can change this. The official board hasn't updated yet.*

![demo](docs/demo.png)

It also draws the picture in plain text, so it shows up in any chat window or terminal:

```
49 of 434 trains late, 4 likely stuck
  +53 min  RE4 (26422)    Neuss Hauptbahnhof ●━━━━▶━━━━○ MG Hbf /Europaplatz
  +40 min  IC 2203        Düsseldorf Hbf ●━━━━▶━━━━○ Köln Hbf  ⚠ likely stuck
  +30 min  ICE 628        Köln Messe/Deutz Bf ●━━▶━━━━━━○ Düsseldorf Hbf  ⚠ likely stuck

RE4 (26422) → Aachen, Hbf  (live)
 ●  Wuppertal Hbf                  14:57  on time
 ●  Düsseldorf Hbf                 15:21  +55 min
 ●  Neuss Hauptbahnhof             15:36  +55 min
 ▼  train is around here
 ○  MG Hbf /Europaplatz            15:50  +53 min
 ○  Aachen, Hbf                    16:37  +53 min
```

---

## How it works

```
┌──────────────────────────────────────────────────────────┐
│  Claude (Code or Desktop)                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Skill: db-delay-predictor                         │  │
│  │  Reasoning playbook: which tool, how to combine    │  │
│  │  signals, how to express confidence honestly.      │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                          │  MCP (stdio, JSON-RPC)
                          ▼
┌──────────────────────────────────────────────────────────┐
│  MCP server: db-mcp (TypeScript)                         │
│  Typed data access. No reasoning.                        │
│  ┌─────────────────────────────────────────────────┐     │
│  │ Transitous: stations, departures, per-stop      │     │
│  │ delays, journeys, trains in an area (realtime)  │     │
│  └─────────────────────────────────────────────────┘     │
│  ┌─────────────────────────────────────────────────┐     │
│  │ DWD: official weather warnings for a location   │     │
│  └─────────────────────────────────────────────────┘     │
│  + short in-memory cache                                 │
└──────────────────────────────────────────────────────────┘
```

Two artifacts. Clean split:

- **The MCP server** knows nothing about reasoning. It's typed access to live data.
- **The skill** knows nothing about API endpoints. It's a reasoning playbook in markdown.

Both are independently testable. Both ship in this repo.

---

## What's interesting under the hood

- **Live data for every kind of train.** Train data comes from [Transitous](https://transitous.org), an open, community-run service built on public timetable and realtime feeds. It covers long-distance, regional, S-Bahn, U-Bahn and tram, with the delay at every stop of a run.
- **Late and stuck trains in an area.** One tool lists the trains currently running late around a point, with an estimated position, and flags those losing 10+ minutes between two stops as likely stuck.
- **Weather context.** A separate client asks DWD (Deutscher Wetterdienst) for the official warnings covering a station's exact location, so the agent can explain delays and check conditions for a planned trip.
- **The skill is honest about uncertainty.** Delay predictions are rounded to 5-minute buckets ("about 10–15 minutes late") because precision would be theater. It says which signals it used, what could change, and when it only has timetable data.
- **7 atomic MCP tools, no reasoning baked in.** `resolve_station`, `get_departures`, `find_train`, `get_train_status`, `plan_journey`, `get_late_trains`, `get_weather_risk`. The skill composes them.
- **Diagrams as plain text.** A train's route and the late trains in an area come back as a metro-style text diagram, because text is the one format every agent and chat app can display.
- **A live smoke check.** Unit tests mock the network, so `npm run smoke -w db-mcp` calls every tool against the real services and fails loudly when an upstream API changes.

---

## Quick start

Build it:

```bash
git clone https://github.com/<you>/wheres-my-db.git
cd wheres-my-db
npm install
npm run build
```

### Wire into Claude Code (terminal)

```bash
claude mcp add db-mcp -s user -- node "$PWD/packages/db-mcp/dist/index.js"
ln -s "$PWD/packages/skill-db-delay" ~/.claude/skills/db-delay-predictor
```

Open a `claude` session, run `/mcp` to confirm `db-mcp` is connected with 7 tools, then ask:

```
Is ICE 597 on time today?
```

### Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/wheres-my-db/packages/db-mcp/dist/index.js"]
    }
  }
}
```

Then symlink the skill the same way and fully quit + relaunch Claude Desktop.

### Wire into Codex CLI

OpenAI's Codex CLI speaks MCP. Edit `~/.codex/config.toml` (create it if missing) and add:

```toml
[mcp_servers.db-mcp]
command = "node"
args = ["/absolute/path/to/wheres-my-db/packages/db-mcp/dist/index.js"]
```

Restart `codex`. The 7 tools (`resolve_station`, `get_departures`, `find_train`, `get_train_status`, `plan_journey`, `get_late_trains`, `get_weather_risk`) become callable from any session.

Codex doesn't load `SKILL.md` automatically. To get the reasoning playbook, paste the contents of `packages/skill-db-delay/SKILL.md` into your project's `AGENTS.md` or the Codex system-prompt equivalent. (Verify the exact mechanism against current Codex docs — the config schema has shifted across versions.)

### Wire into opencode

[opencode](https://opencode.ai) also speaks MCP. Edit `~/.config/opencode/opencode.json` (global) or a project-local `opencode.json`:

```json
{
  "mcp": {
    "db-mcp": {
      "type": "local",
      "command": ["node", "/absolute/path/to/wheres-my-db/packages/db-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

Restart opencode. Same 7 tools become available.

For the reasoning playbook: copy the body of `packages/skill-db-delay/SKILL.md` into your project's `AGENTS.md` (opencode's instruction file) or use it as the system prompt.

### Wire into Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research speaks MCP natively and — unlike Codex and opencode — supports the [agentskills.io](https://agentskills.io) open standard, which is the same format `SKILL.md` uses. The skill auto-loads, no system-prompt copy-paste needed.

Add the MCP to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  db-mcp:
    command: "node"
    args: ["/absolute/path/to/wheres-my-db/packages/db-mcp/dist/index.js"]
```

Then install the skill by symlinking the same way as for Claude:

```bash
mkdir -p ~/.hermes/skills
ln -s "$PWD/packages/skill-db-delay" ~/.hermes/skills/db-delay-predictor
```

Run `hermes chat` and ask:

```
Is ICE 597 on time today?
```

### Any other MCP client

The server is a stdio MCP — it speaks JSON-RPC over stdin/stdout per the [Model Context Protocol spec](https://modelcontextprotocol.io). Any client that implements MCP can use it. The shape is always roughly the same: a command + args pointing at `packages/db-mcp/dist/index.js`. The skill is Claude-specific in its frontmatter format, but its prose transfers cleanly into any system-prompt or custom-instructions slot.

---

## Repo layout

```
packages/
├── db-mcp/                  TypeScript MCP server
│   ├── src/
│   │   ├── server.ts        wiring + cache integration
│   │   ├── tools/           one file per MCP tool
│   │   ├── clients/         Transitous (trains) + DWD (weather)
│   │   ├── render.ts        plain-text route and late-train diagrams
│   │   ├── cache.ts         LRU
│   │   └── types.ts         normalized domain types
│   ├── scripts/smoke.mjs    live check against the real services
│   └── tests/               vitest + msw
└── skill-db-delay/
    └── SKILL.md             the reasoning playbook
```

---

## Test it

```bash
npm test
```

Tests cover the cache, both data clients, the tools, and server wiring. Network calls are mocked via [msw](https://mswjs.io), using trimmed real responses as fixtures; failure modes (timeout, 5xx, malformed bodies) are part of the test surface.

To check the real services are still reachable and shaped as expected:

```bash
npm run smoke -w db-mcp
```

---

## Credits

- [Transitous](https://transitous.org) — the open, community-run transit API (built on [MOTIS](https://github.com/motis-project/motis)) that provides all train data. Please use it considerately.
- [DWD (Deutscher Wetterdienst)](https://www.dwd.de) — Germany's official weather service, source of the weather warnings.

## License

MIT
