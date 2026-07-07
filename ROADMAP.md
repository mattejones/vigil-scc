# Vigil SCC — Roadmap

Items are grouped by area. Priority: 🔴 High / 🟡 Medium / 🟢 Low.
Update this file as items are completed or reprioritised.

---

## UI — Connection Management ✅

- [x] Connection list in sidebar showing name, host, status dot, last connected time
- [x] "Add connection" button → modal with fields: name, host, port, username, auth_type (key/password), private_key or password
- [x] "Edit connection" — open same modal pre-filled
- [x] "Delete connection" — confirm dialog, disallow if a session is active
- [x] "Test connection" button — attempts SSH connect and shows success/error inline
- [x] Connect / Disconnect toggle per connection

**API endpoints:**
- [x] `POST /api/connections` — create
- [x] `PUT /api/connections/:id` — update
- [x] `DELETE /api/connections/:id` — delete (blocked if connected)
- [x] `POST /api/connections/:id/connect` — explicit connect
- [x] `POST /api/connections/:id/disconnect` — explicit disconnect
- [x] `POST /api/connections/test` — test params without saving

---

## UI — Queue UX 🔴

### Approve flow
- [ ] Clicking Approve opens a confirmation modal showing all commands in the batch
- [ ] Modal allows **editing individual commands** before approval (edit inline in modal)
- [ ] Rejection modal with a required/optional note field
- [ ] "Always approve" toggle per connection — auto-approves all future tokens for that connection without human review (stored in connections table, new column `auto_approve BOOLEAN DEFAULT 0`)

### Queue management
- [ ] "Clear completed" button — removes COMPLETED/FAILED/REJECTED tokens from view (soft delete — add `hidden BOOLEAN DEFAULT 0` to tokens, filter in list query)
- [ ] Filter tokens by connection (dropdown or sidebar click)
- [ ] Badge on browser tab showing pending count (`document.title`)

### Browser notifications 🔴
- [ ] Request `Notification` permission on first load
- [ ] Fire a browser notification when a new `token:created` event arrives
- [ ] Notification click focuses the window and selects the token
- [ ] Respect user preference (don't re-request if already denied)

---

## UI — Terminal Pane 🟡

xterm.js is installed. A terminal pane per connection shows the live shell session.

- [ ] Terminal tab per connection in the detail panel or a dedicated split view
- [ ] Read-only by default — streams SSH output via Socket.io
- [ ] When human injection is enabled: bidirectional (operator can type)
- [ ] "Inject command" input below the terminal (explicit, not free-type) for safety

**Implementation notes:**
- Server side: pipe SSH stream data to a socket room named `terminal:{connectionId}`
- Client side: `xterm.js` Terminal writes data from that room
- The SSH registry needs to emit stream data events on the queue EventEmitter (or directly via io)

---

## Functional — File Transfer 🟡

Send scripts and files to remote servers over SFTP (built into ssh2).

- [ ] `POST /api/connections/:id/upload` — multipart file upload endpoint
- [ ] Server opens SFTP subsystem on the SSH connection and writes the file
- [ ] UI: drag-and-drop or file picker in connection detail
- [ ] MCP tool: `vigil_upload_file` — base64 encoded file content, remote path
- [ ] Files uploaded show in session_events log

**ssh2 SFTP example:**
```typescript
client.sftp((err, sftp) => {
  const writeStream = sftp.createWriteStream('/remote/path/script.sh');
  fs.createReadStream('/local/path').pipe(writeStream);
});
```

---

## Functional — Command Sequences / Batching 🟡

The token model already supports multiple commands in a batch. The UI needs to expose this.

- [ ] Multi-command input in the "new batch" UI (add/remove rows)
- [ ] Per-command `fatal` toggle (continue or halt on failure)
- [ ] Saved command templates — store named sequences in a new `templates` table
- [ ] Template picker in the batch modal

---

## Functional — Auto-approve ✅ (partial)

- [x] Add `auto_approve BOOLEAN DEFAULT 0` column to connections table (with migration)
- [x] In `QueueManager.enqueue()`: if the connection has `auto_approve = true`, call `approve()` immediately after `createToken()`
- [x] UI toggle in connection modal and quick-toggle button in sidebar
- [ ] Visual indicator on token cards when auto-approved (distinguish from human-approved)
- [ ] Audit log note: "auto-approved" in the token record

---

## Functional — Human Injection 🟡

The queue engine has `inject()` implemented but no UI surface.

- [ ] "Inject command" panel in terminal pane or connection detail
- [ ] Input field + send button
- [ ] Injection pauses the AI queue for that connection (already implemented in queue.ts)
- [ ] Queue resumes automatically after injection completes
- [ ] Injected commands appear in session_mutations on the active token

---

## Security / Production Hardening 🟢

- [ ] Encrypt `password` and `private_key` fields at rest (use `crypto.createCipheriv` with a key from env)
- [ ] Add authentication to the web UI (even basic — shared secret header or local-only binding)
- [ ] Rate-limit the MCP endpoint
- [ ] Restrict which commands can be run (allowlist/blocklist patterns per connection)
- [ ] Nginx reverse proxy config for homelab deployment with Let's Encrypt

---

## Infrastructure 🟢

- [ ] Docker Compose with named volumes for SQLite persistence
- [ ] Health check endpoint improvements (report active SSH sessions, queue depth)
- [ ] Structured JSON logging (replace console.log with a proper logger)
- [ ] Graceful shutdown — close SSH sessions and drain queue before exit

---

## Completed ✅

- [x] Token store (SQLite, WAL mode)
- [x] Queue engine (EventEmitter, per-connection FIFO, stub executor)
- [x] MCP server (StreamableHTTP, session-per-transport)
- [x] MCP tools: list_connections, add_connection, enqueue, poll, queue_status, cancel
- [x] SSH registry (persistent shell sessions, no-PTY mode, sentinel-based output capture)
- [x] REST API: GET/POST tokens, approve, reject, GET connections
- [x] Socket.io queue→UI bridge
- [x] React UI: dark operator console aesthetic, connection sidebar, token cards, detail panel
- [x] CLAUDE.md project context file
- [x] Connection CRUD UI (modal, add/edit/delete, connect/disconnect, test connection)
- [x] Auto-approve per connection (DB column + queue logic + UI toggle)
