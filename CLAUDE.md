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
PENDING_APPROVAL → APPROVED → RUNNING ⇄ WAITING_FOR_INPUT
                ↘ REJECTED            ↘ COMPLETED
                                      ↘ FAILED (EXEC_FAILURE | STOPPED | TIMEOUT |
                                                CONNECTION_ERROR | SESSION_LOST | SERVER_RESTART)
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

**Important execution decision — tracked runs:** Every command runs out of a run
directory on the remote host (`$VIGIL_REMOTE_DIR/<token_id>-<index>/`, default
`$HOME/.vigil/runs`) holding a stdin FIFO (`in`), output log (`out`), `exit`, and
`shell`/`holder` pids. The command still runs in the persistent shell's foreground
(inside a `__vigil_run` shell function, so cwd/env persist), but its stdout+stderr go
to `out` (followed with `tail -f` over a side exec channel) and its stdin comes from
the FIFO. Consequences:
- Output survives a dropped channel or a Vigil restart → Vigil **reattaches** on
  startup / reconnect (`QueueManager.init()`, `recoverCommand()`).
- Input is written to the FIFO over a separate channel, so it can never be executed
  by the shell (the old "prompt swallows the next queued command" wedge).
- The run dir path is persisted on the command (`commands[i].remote_run`).
- If the run dir can't be created, the command falls back to the untracked
  channel wrapper (no input, no recovery).

**Important stop decision:** There is no timeout by default (`CMD_TIMEOUT_MS=0`).
Stopping (UI Stop button, `vigil_cancel`, or `timeout_seconds`) sends SIGINT to the
shell plus SIGINT → SIGTERM → SIGKILL to the shell's descendants (found via `ps`/`/proc`
from a side channel). While a command runs the shell has `trap 'return 130' INT`, so
loops and builtins that execute in the shell itself are aborted without killing the
shell; between commands the shell has `trap : INT`. Only if the command survives
SIGKILL is the session torn down. **Never release the session lock on timeout** —
that was the original 30s wedge bug: the command kept running while the next one was
written into the same shell.

**Important MCP decision:** One `McpServer` instance per transport session.
The SDK enforces 1:1 between McpServer and transport. `createMcpServer()` is a
factory in `src/mcp/server.ts`.

---

## Project Structure

```
vigil-scc/
├── src/
│   ├── index.ts          Entry point — bootstraps DB, queue, SSH, starts both servers
│   ├── config.ts         Env-backed config getters (read lazily)
│   ├── mcp/
│   │   ├── server.ts     McpServer factory + all tool/resource definitions
│   │   ├── router.ts     Express router, StreamableHTTP session management
│   │   └── index.ts      Barrel
│   ├── ssh/
│   │   ├── registry.ts       SshRegistry (CommandRunner) — maps connection → ShellSession + CommandRun
│   │   ├── shell-session.ts  ShellSession — ssh2 client + no-PTY shell, handshake, side exec channels
│   │   ├── command-run.ts    CommandRun — one command's lifecycle: wrapper, tail, stop escalation, stdin probe
│   │   ├── shell-protocol.ts Pure text written to the shell (handshake, run wrapper) + marker parsers
│   │   ├── remote-ops.ts     Side-channel helper scripts + parsing (inspect, signal, probe, input, list, cleanup)
│   │   ├── output-buffer.ts  Capped/decoded command output, prompt extraction
│   │   └── index.ts          Singleton + wires runner into queue
│   ├── queue/
│   │   ├── types.ts      All shared TypeScript interfaces
│   │   ├── store.ts      SQLite CRUD — tokens, connections, session_events
│   │   ├── queue.ts      QueueManager (EventEmitter) — enqueue/approve/exec/stop/input/recovery
│   │   └── index.ts      Barrel
│   └── api/
│       └── router.ts     REST API — tokens (approve/reject/stop/input), connections, orphans
├── client/               React app (Vite)
│   └── src/
│       ├── App.tsx        Main layout, socket.io, state
│       ├── types.ts       Client-side type mirrors
│       ├── index.css      Design system (CSS custom properties)
│       └── components/
│           ├── Sidebar.tsx       Connection list
│           ├── TokenCard.tsx     Queue item with approve/reject/stop
│           └── TokenDetail.tsx   Live output, Stop, input panel, AI input approvals
├── data/                 SQLite DB (gitignored)
├── certs/                mkcert TLS certs for HTTPS MCP (gitignored)
├── .env                  Local config (copy from .env.example)
└── docker-compose.yml
```

---

## Running Locally (WSL)

```bash
npm run up           # server (:3000 web, :3001 mcp, auto-reload) + Vite UI (:5173)
npm run up:prod      # build both, serve UI + API from :3000
```

On Windows, `Vigil.cmd` (repo root) runs `scripts/vigil.sh dev --open` inside WSL.

`scripts/vigil.sh` loads Node 20+ via nvm when the shell's node is older, runs
`npm install` when `node_modules` is missing or older than the lockfile, creates `.env`,
refuses to start if a port is taken, and supervises both processes: each runs in its
own session (process group) with a watchdog, so Ctrl+C, one service exiting, or the
launcher being killed stops everything. `.gitattributes` keeps `*.sh` LF and `*.cmd` CRLF.
When the repo is on a Windows drive (`/mnt/*`) nodemon runs with `--legacy-watch`:
inotify events don't cross into WSL2 there, so file watching must poll.

Manual equivalent: `npm run dev` in the root and `npm run dev` in `client/`.

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

**Execution env vars** (see `.env.example`): `CMD_TIMEOUT_MS` (0 = none),
`INTERRUPT_GRACE_MS`, `INPUT_IDLE_MS`, `OUTPUT_MAX_BYTES`, `VIGIL_REMOTE_DIR`,
`RECOVERY_TIMEOUT_MS`, `SSH_KEEPALIVE_INTERVAL_MS`, `SSH_KEEPALIVE_COUNT_MAX`,
`SSH_READY_TIMEOUT_MS`. Env is read lazily (ESM imports run before `dotenv.config()`).

---

## MCP Tools (what the AI can call)

| Tool | Purpose |
|---|---|
| `vigil_list_connections` | List registered SSH connections |
| `vigil_add_connection` | Register a new SSH connection |
| `vigil_enqueue` | Submit commands for human approval (optional per-command `timeout_seconds`) |
| `vigil_poll` | Check token status, partial output, `waiting_for_input`, `input_mode` |
| `vigil_wait` | Long-poll (≤50s) until the token changes state |
| `vigil_send_input` | Send stdin to a running command (needs approval unless `auto_approve`/`auto_approve_input`) |
| `vigil_queue_status` | View active queue |
| `vigil_cancel` | Withdraw a pending/queued token, or stop a running one |

**Polling pattern:** The AI calls `vigil_enqueue`, receives a `token_id`, then
calls `vigil_wait` until `is_terminal: true`. If the token is `WAITING_FOR_INPUT`
and `input_mode` is `requires_approval`, the AI tells the operator what the prompt
says and what it proposes, then calls `vigil_send_input` (shows as a one-click
approval in the UI).

**Waiting-for-input detection:** after `INPUT_IDLE_MS` without output, a side-channel
probe checks whether the shell or a descendant is blocked reading the run's FIFO
(`/proc/<pid>/fd/0` + `wchan`/`syscall`); falls back to "last output line has no
newline" when `/proc` is unavailable.

---

## Database Schema

```sql
tokens (
  id, description, status, connection_id, source,
  commands TEXT (JSON),           -- Command[] (incl. timeout_seconds, remote_run)
  error TEXT (JSON),              -- TokenError | null
  session_mutations TEXT (JSON),  -- SessionMutation[]
  waiting_for_input TEXT (JSON),  -- { command_index, prompt, recent_output, since } | null
  input_requests TEXT (JSON),     -- InputRequest[] (PENDING/SENT/REJECTED/EXPIRED/FAILED)
  recovered INTEGER,              -- reattached after restart / dropped connection
  created_at, updated_at, approved_at, completed_at
)

connections (
  id, name, host, port, username,
  auth_type TEXT ('key' | 'password'),
  auto_approve INTEGER, auto_approve_input INTEGER,
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

- The persistent shell must be POSIX-like (bash/zsh/dash); fish is not supported
- Stop/probe/input rely on `ps` or `/proc`, `mkfifo`, `tail -f` on the host
- Processes running as root under `sudo` may refuse signals — Stop then ends in a session reset
- `read -p` prompts aren't printed without a tty, so builtin prompts show no prompt text
- A command that resets the shell's INT trap (`trap - INT`) makes Stop kill the shell (session reset)
- No SFTP/file upload support yet
- No terminal pane (xterm.js installed but not wired)
- No browser notifications
- On restart / reconnect, shell state (cwd, env) is lost; in-flight runs are reattached but
  the rest of their batch is not run (`SESSION_LOST`)
- Connections table stores passwords in plaintext — acceptable for homelab, needs encryption for production

---

## Key Conventions

- All TypeScript files use `.js` extension in imports (NodeNext module resolution)
- `better-sqlite3` operations are synchronous — no async/await in store functions
- Queue events are emitted via `queue` (EventEmitter) and bridged to Socket.io in `index.ts`
- New SSH connections lazy-connect on first `exec()` call
- The `QueueManager` uses per-connection FIFOs (`connectionQueues` map) — one batch runs per connection at a time
- The queue talks to SSH only through the `CommandRunner` interface (`queue/types.ts`)
- `index.ts` must call `initSsh()` before `queue.init()`: init reattaches in-flight runs
- On startup APPROVED tokens are marked FAILED (`reconcileStaleTokens()`); RUNNING/WAITING tokens
  with a `remote_run` are reattached, others fail with SERVER_RESTART
- On every connect, finished run dirs no token owns are collected (late results attached to
  SESSION_LOST tokens) and deleted; live ones are listed at `GET /api/connections/:id/orphans`
- Never `rm -rf` run dirs — `cleanupRun()` deletes the known files and `rmdir`s
