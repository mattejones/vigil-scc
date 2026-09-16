import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { queue, TERMINAL_STATUSES } from '../queue/queue.js';
import { listConnections, getToken, listTokens, createConnection } from '../queue/store.js';
import type { Token } from '../queue/types.js';

// Factory — each transport connection gets its own McpServer instance.
// The SDK does not allow a single McpServer to connect to more than one transport.
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name:    'vigil-scc',
    version: '0.1.0',
  });

  registerAll(server);
  return server;
}

function registerAll(mcpServer: McpServer): void {

// ─── Resource: usage guide ────────────────────────────────────────────────────

mcpServer.resource(
  'vigil-guide',
  'vigil://guide',
  { description: 'How to use Vigil SCC — read this before using any tools.' },
  async () => ({
    contents: [{
      uri:      'vigil://guide',
      mimeType: 'text/plain',
      text: `
VIGIL SSH COMMAND CENTER — USAGE GUIDE
=======================================

Vigil is a human-supervised command execution system. Every command you submit
is reviewed by a human operator before it runs on a remote server.

WORKFLOW
--------
1. Call vigil_list_connections to see available servers.
2. Call vigil_enqueue to submit one or more commands for approval.
   - You MUST provide a clear, specific description — the human reads this to decide whether to approve.
   - Commands run sequentially. A non-zero exit on a fatal command halts the batch.
3. Call vigil_wait (preferred) or vigil_poll with the returned token_id until is_terminal is true.
   - vigil_wait blocks up to ~50s and returns as soon as something changes.
   - Commands may run for a long time; there is no timeout by default. Partial output
     appears in commands[i].output while the token is RUNNING.
4. On COMPLETED: read the output from each command's output field.
5. On FAILED or REJECTED: read the error field. Replan accordingly — do not blindly retry.

LONG-RUNNING COMMANDS
---------------------
- Set commands[i].timeout_seconds if a command should be stopped after a known time.
- To stop a running command yourself, call vigil_cancel (SIGINT, then SIGTERM, then SIGKILL).
- The operator can also Stop a command at any time. error.reason is then STOPPED (or TIMEOUT).

INTERACTIVE PROMPTS
-------------------
Prefer non-interactive flags (apt-get -y, --yes, --non-interactive, heredocs). If a command
does block on input, the token becomes WAITING_FOR_INPUT and vigil_poll / vigil_wait return
waiting_for_input.prompt and recent_output, plus input_mode:
- input_mode "direct": call vigil_send_input with the answer; it is delivered immediately.
- input_mode "requires_approval": tell the operator in chat what the prompt says and what you
  propose to send, then call vigil_send_input. The request appears in Vigil for one-click
  approval; follow it in input_requests (PENDING → SENT / REJECTED / EXPIRED).
Never send passwords or secrets as input — ask the operator to type those in Vigil.

TOKEN STATUSES
--------------
PENDING_APPROVAL  Waiting for the human operator to approve or reject.
APPROVED          Approved, queued for execution (another batch may be ahead of it).
RUNNING           Currently executing on the server.
WAITING_FOR_INPUT The running command is blocked waiting for stdin (see INTERACTIVE PROMPTS).
COMPLETED         All commands finished successfully.
FAILED            A command exited non-zero (fatal=true), was stopped, or a connection error occurred.
REJECTED          The human operator rejected the batch.

IMPORTANT BEHAVIOURS
--------------------
- The human operator may inject commands directly into the session. If this happens,
  session_mutations in the token will contain those commands and their output.
  Reconcile your understanding of server state with these mutations before proceeding.
- If a batch is rejected, check error.human_note for the operator's reason.
- Connections are persistent SSH sessions. You do not need to re-authenticate between batches.
- Commands are tracked on the host. If Vigil restarts or the connection drops mid-command, it
  reattaches (recovered: true). Shell state (cwd, env) from earlier commands is lost in that case,
  so the rest of the batch is not run (error.reason SESSION_LOST) — replan from the output.
- Per connection, only one batch runs at a time. Multiple connections run in parallel.
`.trim(),
    }],
  })
);

// ─── Tool: list connections ───────────────────────────────────────────────────

mcpServer.tool(
  'vigil_list_connections',
  'List all available SSH connections. Call this first to get connection IDs for vigil_enqueue.',
  {},
  async () => {
    const connections = listConnections().map((c) => ({
      id:                 c.id,
      name:               c.name,
      host:               c.host,
      port:               c.port,
      username:           c.username,
      status:             c.status,
      auto_approve:       c.auto_approve,
      auto_approve_input: c.auto_approve_input,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ connections }, null, 2),
      }],
    };
  }
);

// ─── Tool: add connection ─────────────────────────────────────────────────────

mcpServer.tool(
  'vigil_add_connection',
  `Register a new SSH connection in the Vigil connection registry.
The connection is stored in the database and available immediately for vigil_enqueue.
Connections are lazy — the SSH session is not opened until the first command is enqueued.
Use auth_type "key" with the PEM-encoded private key content, or "password" with a plaintext password.`,
  {
    name:        z.string().min(1).describe('Human-friendly label for this connection (e.g. "prod-web-01")'),
    host:        z.string().min(1).describe('Hostname or IP address'),
    port:        z.number().int().min(1).max(65535).optional().describe('SSH port, defaults to 22'),
    username:    z.string().min(1).describe('SSH username'),
    auth_type:   z.enum(['key', 'password']).describe('Authentication method'),
    private_key: z.string().optional().describe('PEM-encoded private key content (required when auth_type is "key")'),
    password:    z.string().optional().describe('Password (required when auth_type is "password")'),
  },
  async ({ name, host, port, username, auth_type, private_key, password }) => {
    try {
      if (auth_type === 'key' && !private_key) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'private_key is required when auth_type is "key"' }) }],
        };
      }
      if (auth_type === 'password' && !password) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'password is required when auth_type is "password"' }) }],
        };
      }

      const conn = createConnection({
        name,
        host,
        port:        port ?? 22,
        username,
        auth_type,
        private_key,
        password,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            connection_id: conn.id,
            name:          conn.name,
            host:          conn.host,
            port:          conn.port,
            username:      conn.username,
            message:       `Connection "${name}" registered. Use connection_id "${conn.id}" in vigil_enqueue.`,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
      };
    }
  }
);

// ─── Tool: enqueue ────────────────────────────────────────────────────────────

mcpServer.tool(
  'vigil_enqueue',
  `Submit one or more shell commands to run on a remote server.
Commands are queued for human approval before execution.

IMPORTANT:
- description is required and must clearly explain what you are doing and why.
  The human operator reads this to make the approval decision.
- Commands run sequentially in the order given.
- fatal (default: true) — if a command exits non-zero, the batch halts.
  Set fatal: false for commands where failure is expected or acceptable (e.g. mkdir -p).
- Long-running commands are fine: there is no timeout unless you set timeout_seconds.
- Prefer non-interactive flags; if a command prompts for input, see vigil_send_input.
- After calling this, use vigil_wait (or vigil_poll) with the returned token_id to follow progress.`,
  {
    connection_id: z.string().describe('ID of the target SSH connection from vigil_list_connections'),
    description:   z.string().min(10).describe('Clear human-readable explanation of what this batch does and why'),
    commands: z.array(z.object({
      command: z.string().min(1).describe('The shell command to run'),
      fatal:   z.boolean().optional().describe('Halt batch on non-zero exit. Defaults to true.'),
      timeout_seconds: z.number().int().min(1).optional()
        .describe('Stop the command (SIGINT → SIGTERM → SIGKILL) if it runs longer than this. Default: no timeout.'),
    })).min(1).describe('Ordered list of commands to execute'),
  },
  async ({ connection_id, description, commands }) => {
    try {
      const token = queue.enqueue({ connection_id, description, commands });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            token_id:      token.id,
            status:        token.status,
            command_count: token.commands.length,
            message: `${commands.length} command(s) queued for human approval. ` +
                     `Call vigil_wait with token_id "${token.id}" until is_terminal is true.`,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
      };
    }
  }
);

// ─── Tool: poll ───────────────────────────────────────────────────────────────

mcpServer.tool(
  'vigil_poll',
  `Check the status and output of a previously enqueued token.
Call this until is_terminal is true (or use vigil_wait, which blocks until something changes).
While RUNNING, commands[i].output holds partial output.
If status is WAITING_FOR_INPUT, read waiting_for_input and input_mode, then see vigil_send_input.
On COMPLETED: read output from each command in the commands array.
On FAILED or REJECTED: read the error field and replan — do not blindly retry.
Check session_mutations for any commands the human injected directly into the session.`,
  {
    token_id: z.string().describe('Token ID returned by vigil_enqueue'),
  },
  async ({ token_id }) => {
    const token = getToken(token_id);
    if (!token) return tokenNotFound(token_id);
    return tokenResponse(token);
  }
);

// ─── Tool: wait ───────────────────────────────────────────────────────────────

mcpServer.tool(
  'vigil_wait',
  `Like vigil_poll, but blocks until the token changes state (approved, started, completed, failed,
starts or stops waiting for input, an input request resolves) or timeout_seconds elapses, then
returns the same payload as vigil_poll. Use this instead of polling in a tight loop.`,
  {
    token_id:        z.string().describe('Token ID returned by vigil_enqueue'),
    timeout_seconds: z.number().int().min(1).max(50).optional().describe('Maximum time to block (default 30, max 50)'),
  },
  async ({ token_id, timeout_seconds }) => {
    const token = getToken(token_id);
    if (!token) return tokenNotFound(token_id);

    // Return immediately when the caller has something to act on.
    const actionable = TERMINAL_STATUSES.includes(token.status) ||
      (token.status === 'WAITING_FOR_INPUT' && !token.input_requests.some((r) => r.status === 'PENDING'));
    if (!actionable) {
      await queue.waitForChange(token_id, (timeout_seconds ?? 30) * 1000);
    }
    return tokenResponse(getToken(token_id)!);
  }
);

// ─── Tool: send input ─────────────────────────────────────────────────────────

mcpServer.tool(
  'vigil_send_input',
  `Send stdin to a running command, typically one whose token is WAITING_FOR_INPUT (e.g. to answer
a "Continue? [Y/n]" prompt).
- If input_mode is "direct", it is delivered immediately (status SENT).
- Otherwise it needs operator approval (status PENDING). Tell the operator in chat what the prompt
  says and what you are sending, then use vigil_wait to see it resolve (SENT / REJECTED / EXPIRED).
Never send passwords or other secrets — ask the operator to enter those in Vigil.`,
  {
    token_id: z.string().describe('Token ID of the running command'),
    data:     z.string().describe('Text to send (may be empty when only sending EOF)'),
    newline:  z.boolean().optional().describe('Append a newline (press Enter). Defaults to true.'),
    eof:      z.boolean().optional().describe('Close stdin after sending (like Ctrl+D). Defaults to false.'),
  },
  async ({ token_id, data, newline, eof }) => {
    try {
      const request = await queue.sendInput(token_id, { data, newline, eof }, 'AI');
      const message =
        request.status === 'PENDING' ? 'Input is awaiting operator approval in Vigil. Let the operator know, then call vigil_wait.' :
        request.status === 'SENT'    ? 'Input delivered to the command.' :
        `Input was not delivered: ${request.error ?? request.status}`;

      return {
        ...(request.status === 'FAILED' || request.status === 'EXPIRED' ? { isError: true } : {}),
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ request_id: request.id, status: request.status, error: request.error, message }, null, 2),
        }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
      };
    }
  }
);

// ─── Tool: queue status ───────────────────────────────────────────────────────

mcpServer.tool(
  'vigil_queue_status',
  'View all active tokens in the queue (PENDING_APPROVAL, APPROVED, RUNNING, WAITING_FOR_INPUT). Useful for understanding what is currently waiting or in progress.',
  {},
  async () => {
    const active = listTokens(['PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'WAITING_FOR_INPUT']);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          count:  active.length,
          tokens: active.map((t) => ({
            token_id:      t.id,
            status:        t.status,
            description:   t.description,
            connection_id: t.connection_id,
            command_count: t.commands.length,
            created_at:    t.created_at,
          })),
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: cancel ─────────────────────────────────────────────────────────────

mcpServer.tool(
  'vigil_cancel',
  `Cancel a token at any non-terminal stage.
- PENDING_APPROVAL / APPROVED: withdrawn before it runs.
- RUNNING / WAITING_FOR_INPUT: the running command is stopped (SIGINT, then SIGTERM, then SIGKILL)
  and the rest of the batch is skipped. The token becomes FAILED with error.reason STOPPED — use
  vigil_wait to see the final output.`,
  {
    token_id: z.string().describe('Token ID to cancel'),
    reason:   z.string().optional().describe('Optional reason for cancellation'),
  },
  async ({ token_id, reason }) => {
    try {
      const before  = getToken(token_id);
      const running = before?.status === 'RUNNING' || before?.status === 'WAITING_FOR_INPUT';
      await queue.cancel(token_id, 'AI', reason ? `[AI cancelled] ${reason}` : '[AI cancelled]');
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            token_id,
            message: running ? 'Stop requested. Call vigil_wait to see the final status and output.' : 'Token cancelled.',
          }),
        }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
      };
    }
  }
);

} // end registerAll

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tokenNotFound(tokenId: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: `Token not found: ${tokenId}` }) }],
  };
}

function tokenResponse(token: Token) {
  const isTerminal = TERMINAL_STATUSES.includes(token.status);
  const running    = token.commands.find((c) => c.executed_at && !c.completed_at);
  const inputMode  = queue.inputAutoApproved(token.connection_id) ? 'direct' : 'requires_approval';
  const pending    = token.input_requests.some((r) => r.status === 'PENDING');

  let hint: string | undefined;
  if (token.status === 'WAITING_FOR_INPUT') {
    hint = pending
      ? 'Your input is awaiting operator approval in Vigil. Remind the operator if needed, then call vigil_wait.'
      : inputMode === 'direct'
        ? 'The command is waiting for input. Answer with vigil_send_input, or vigil_cancel to stop it.'
        : 'The command is waiting for input, and input needs operator approval. Tell the operator what the ' +
          'prompt says and what you propose to send, then call vigil_send_input (or vigil_cancel to stop it).';
  } else if (!isTerminal) {
    hint = 'Status is not yet terminal. Call vigil_wait to block until it changes.';
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        token_id:              token.id,
        status:                token.status,
        is_terminal:           isTerminal,
        description:           token.description,
        connection_id:         token.connection_id,
        running_command_index: running && !isTerminal ? running.index : null,
        recovered:             token.recovered ?? false,
        waiting_for_input:     token.waiting_for_input ?? null,
        input_mode:            inputMode,
        input_requests:        token.input_requests,
        commands:              token.commands.map(({ remote_run: _run, ...c }) => c),
        error:                 token.error ?? null,
        session_mutations:     token.session_mutations,
        created_at:            token.created_at,
        updated_at:            token.updated_at,
        approved_at:           token.approved_at ?? null,
        completed_at:          token.completed_at ?? null,
        ...(hint ? { hint } : {}),
      }, null, 2),
    }],
  };
}
