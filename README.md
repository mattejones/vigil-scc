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

```bash
cp .env.example .env
npm install
npm run dev
```

Web UI: http://localhost:3000
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
