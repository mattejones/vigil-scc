# Vigil SCC — Claude Code Context

## What this is

Vigil SCC (SSH Command Center) is a **human-on-the-loop** command execution platform.
An AI agent (Claude) submits shell commands to remote servers via MCP tools. A human
operator watches in real time via a web UI and approves or rejects commands before
they execute. The human can also inject commands directly into the session.

This project is being developed iteratively. Claude Code should read this file in full
before making any changes, and update it when significant decisions are made or
features are completed.

---

## Architecture

```
Claude (AI) ──MCP──► Vigil Server (Node.js)
                           │
                    ┌──────┴──────┐
                    │             │
               Token Store    SSH Registry
               (SQLite)       (ssh2 persistent shells)
                    │             │
               Queue Engine       │
               (EventEmitter)     │
                    │             │
               WebSocket bridge   │
                    │             │
               Web UI (React) ◄───┘
               Approve / Reject / Inject / Manage
```

**Two HTTP servers:**
- Port 3000 — Web UI + REST API + Socket.io
- Port 3001 — MCP endpoint (StreamableHTTP transport)

**Token lifecycle:**
```
PENDING_APPROVAL → APPROVED → RUNNING → COMPLETED
                ↘ REJECTED
                              ↘ FAILED
                                        WAITING_FOR_INPUT
```

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js + TypeScript | ESM modules (`"type": "module"`) |
| MCP | `@modelcontextprotocol/sdk` v1.29.0 | StreamableHTTP transport |
| SSH | `ssh2` | Persistent shell sessions, no PTY (`client.shell(false, ...)`) |
| DB | `better-sqlite3` | WAL mode, JSON columns for commands/error/mutations |
| HTTP | Express | Two separate Express apps (web + MCP) |
| Realtime | Socket.io | Queue events bridge to UI |
| UI | React + Vite | TypeScript, no Tailwind (plain CSS custom properties) |
| Terminal | `xterm.js` | Installed, not yet wired |

**Important SSH decision:** Shell sessions use `client.shell(false, ...)` (no PTY).
This prevents the terminal driver echoing input commands back into the output stream,
which previously caused the sentinel to match prematurely on the command echo.
Without PTY, `isatty()` returns false so programs output in non-interactive mode —
desirable for clean parseable output.

**Important MCP decision:** One `McpServer` instance per transport session.
The SDK enforces 1:1 between McpServer and transport. `createMcpServer()` is a
factory in `src/mcp/server.ts`.

---

## Project Structure

```
vigil-scc/
├── src/
│   ├── index.ts          Entry point — bootstraps DB, queue, SSH, starts both servers
│   ├── mcp/
│   │   ├── server.ts     McpServer factory + all tool/resource definitions
│   │   ├── router.ts     Express router, StreamableHTTP session management
│   │   └── index.ts      Barrel
│   ├── ssh/
│   │   ├── registry.ts   SshRegistry class — connect/disconnect/exec/handleData
│   │   └── index.ts      Singleton + wires executor into queue
│   ├── queue/
│   │   ├── types.ts      All shared TypeScript interfaces
│   │   ├── store.ts      SQLite CRUD — tokens, connections, session_events
│   │   ├── queue.ts      QueueManager (EventEmitter) — enqueue/approve/reject/exec
│   │   └── index.ts      Barrel
│   └── api/
│       └── router.ts     REST API — /api/tokens, /api/connections
├── client/               React app (Vite)
│   └── src/
│       ├── App.tsx        Main layout, socket.io, state
│       ├── types.ts       Client-side type mirrors
│       ├── index.css      Design system (CSS custom properties)
│       └── components/
│           ├── Sidebar.tsx       Connection list
│           ├── TokenCard.tsx     Queue item with approve/reject
│           └── TokenDetail.tsx   Expanded command output panel
├── data/                 SQLite DB (gitignored)
├── certs/                mkcert TLS certs for HTTPS MCP (gitignored)
├── .env                  Local config (copy from .env.example)
└── docker-compose.yml
```

---

## Running Locally (WSL)

```bash
# Server (from repo root)
npm install
cp .env.example .env
npm run dev          # starts on :3000 (web) and :3001 (mcp)

# Client (separate terminal)
cd client
npm install
npm run dev          # starts on :5173
```

**Claude Desktop / Claude Code MCP config:**
```json
{
  "mcpServers": {
    "vigil-scc": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3001/mcp"]
    }
  }
}
```

**Debug SSH output:** Add `DEBUG_SSH=true` to `.env` to log raw shell data.

---

## MCP Tools (what the AI can call)

| Tool | Purpose |
|---|---|
| `vigil_list_connections` | List registered SSH connections |
| `vigil_add_connection` | Register a new SSH connection |
| `vigil_enqueue` | Submit commands for human approval |
| `vigil_poll` | Check token status and retrieve output |
| `vigil_queue_status` | View active queue |
| `vigil_cancel` | Cancel a PENDING_APPROVAL token |

**Polling pattern:** The AI calls `vigil_enqueue`, receives a `token_id`, then
calls `vigil_poll` every few seconds until `is_terminal: true`.

---

## Database Schema

```sql
tokens (
  id, description, status, connection_id, source,
  commands TEXT (JSON),           -- Command[]
  error TEXT (JSON),              -- TokenError | null
  session_mutations TEXT (JSON),  -- SessionMutation[]
  created_at, updated_at, approved_at, completed_at
)

connections (
  id, name, host, port, username,
  auth_type TEXT ('key' | 'password'),
  private_key TEXT,   -- PEM content
  password TEXT,
  status, error, created_at, last_connected_at
)

session_events (
  id, connection_id, token_id,
  command, output, stderr, exit_code,
  source TEXT ('AI' | 'HUMAN'),
  created_at
)
```

---

## Known Issues / Bugs

- SSH output can be empty or malformed on some shells — see ROADMAP.md for planned improvements
- No SFTP/file upload support yet
- No terminal pane (xterm.js installed but not wired)
- No browser notifications
- Session state is lost on server restart (SSH sessions are in-memory)
- Connections table stores passwords in plaintext — acceptable for homelab, needs encryption for production

---

## Key Conventions

- All TypeScript files use `.js` extension in imports (NodeNext module resolution)
- `better-sqlite3` operations are synchronous — no async/await in store functions
- Queue events are emitted via `queue` (EventEmitter) and bridged to Socket.io in `index.ts`
- New SSH connections lazy-connect on first `exec()` call
- The `QueueManager` uses per-connection FIFOs (`connectionQueues` map) — one batch runs per connection at a time
- `reconcileStaleTokens()` runs on startup and marks RUNNING/APPROVED tokens as FAILED
