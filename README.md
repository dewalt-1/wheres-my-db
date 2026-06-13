# Deutsche Bahn Delay Predictor

A Claude skill + MCP server that predicts Deutsche Bahn train delays **before** the official timetable shows them — by combining upstream-stop delays, connection-chain data, and active Störungsmeldungen.

## The problem

DB's own apps say "on time" until they don't. The data needed to predict the delay earlier — the same train running 15 min late at its previous stop, a connection it's scheduled to wait for, an active disruption on the line — is technically public but isn't synthesized for the passenger.

## How it works

```
┌──────────────────────────────────────────────────────────┐
│  Claude (Code or Desktop)                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Skill: db-delay-predictor                         │  │
│  │  HOW to reason: which tool, how to combine signals │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                          │  MCP (stdio, JSON-RPC)
                          ▼
┌──────────────────────────────────────────────────────────┐
│  MCP server: db-mcp (TypeScript)                         │
│  Typed data access. No reasoning.                        │
│  ┌─────────────────────┐    ┌─────────────────────┐      │
│  │ marudor (primary)   │ →  │ db-rest (fallback)  │      │
│  └─────────────────────┘    └─────────────────────┘      │
│  + 5-min in-memory LRU cache                             │
└──────────────────────────────────────────────────────────┘
```

The MCP knows nothing about delay reasoning — it's typed data access. The skill knows nothing about API endpoints — it's a reasoning playbook. Both are independently testable.

## What you get

- **`packages/db-mcp`** — TypeScript MCP server exposing 5 atomic tools: `resolve_station`, `find_train`, `get_train_status`, `plan_journey`, `get_disruptions`. Primary data source is [marudor / bahn.expert](https://bahn.expert) (via their tRPC protocol with devalue encoding) with [db-rest](https://github.com/derhuerst/db-rest) as a transparent REST fallback.
- **`packages/skill-db-delay/SKILL.md`** — the reasoning playbook the LLM uses to combine signals into a delay prediction with honest confidence.

## Example conversations

See [`examples/`](./examples/) for saved transcripts: a connection-risk case, a "not yet late but will be" hero case, and a disruption-on-the-route case.

## Install

```bash
git clone <repo>
cd db-delay-predictor
npm install
npm run build
```

Then add to your Claude Desktop or Claude Code MCP config:

```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "node",
      "args": ["<absolute-path-to-this-repo>/packages/db-mcp/dist/index.js"]
    }
  }
}
```

Install the skill by symlinking or copying `packages/skill-db-delay/` into your Claude skills directory (e.g. `~/.claude/skills/`).

## Tested with

- Node 20
- `@modelcontextprotocol/sdk` 1.x
- Claude Code, Claude Desktop

## Tests

```bash
npm test
```

Tests use [`msw`](https://mswjs.io) to mock both providers, including failure modes (timeout → fallback, both providers down → clean error). 52 tests across the suite.

## Stretch goals (not in v0.1)

- **Loop skill**: monitor a specific train at an interval using `/loop`.
- **Hosted HTTP MCP**: deploy with SSE transport so it can be added by URL instead of cloned.
- **Historical baseline collector**: per-train on-time stats over weeks.

## Credits

- [marudor / bahn.expert](https://bahn.expert) — the data source that makes the connection-chain feature possible.
- [db-rest](https://github.com/derhuerst/db-rest) by @derhuerst — REST fallback.

## License

MIT
