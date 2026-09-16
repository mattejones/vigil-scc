# Vigil SCC — SSH Command Center

**Vigil** is a human-on-the-loop command center that bridges AI agents and remote servers via SSH. An AI agent submits commands through an MCP interface; a human operator watches in real time and approves or rejects them before they execute.

## Architecture

```
AI Agent ──MCP──► Command Center ──SSH──► Remote Servers
                       │
                  Token Store (SQLite)
                       │
                  Web UI (HotL)
                  Approve / Reject / Inject
```

## Core Concepts

- **Token** — Every command or batch submitted by the AI is assigned a token. The AI polls this token for status and output.
- **Queue** — Commands enter a queue in `PENDING_APPROVAL` state. The human operator approves or rejects them.
- **Batch** — Commands can be grouped into atomic batches. A single failure or rejection halts the entire batch.
- **Connection Registry** — Named persistent SSH sessions. The AI references connections by ID.
- **Human Injection** — The operator can inject commands directly into a session, pausing the AI queue.

## Token Lifecycle

```
PENDING_APPROVAL → APPROVED → RUNNING → COMPLETED
                ↘ REJECTED
                              ↘ FAILED
                                        WAITING_FOR_INPUT
```

## Getting Started

**One click (Windows + WSL):** double-click `Vigil.cmd`. It starts everything inside WSL and opens the UI.

**One command (WSL / Linux):**

```bash
npm run up          # dev: API + MCP with auto-reload, UI on http://localhost:5173
npm run up:prod     # build, then serve UI + API from http://localhost:3000
```

The launcher (`scripts/vigil.sh`) picks up Node 20+ from nvm if needed, installs
dependencies when they're missing or stale, creates `.env` from `.env.example`,
checks the ports are free, and stops everything on Ctrl+C. Pass `--open` to open
the browser, or run `scripts/vigil.sh --help` for options.

MCP endpoint: http://localhost:3001/mcp

## MCP Configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "vigil-scc": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

## Project Structure

```
src/
  mcp/      MCP server and tool definitions
  ssh/      Connection registry and session management
  queue/    Token store and batch execution engine
  api/      REST endpoints for the web UI
  ws/       Socket.io event handlers
client/     React web UI (xterm.js, Tailwind)
data/       SQLite database (gitignored)
```
