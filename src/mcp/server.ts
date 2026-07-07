import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { queue } from '../queue/queue.js';
import { listConnections, getToken, listTokens, createConnection } from '../queue/store.js';

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
3. Poll vigil_poll with the returned token_id until you get a terminal status.
   - Poll every few seconds. Do not assume immediate execution.
4. On COMPLETED: read the output from each command's output field.
5. On FAILED or REJECTED: read the error field. Replan accordingly — do not blindly retry.

TOKEN STATUSES
--------------
PENDING_APPROVAL  Waiting for the human operator to approve or reject.
APPROVED          Approved, queued for execution (another batch may be ahead of it).
RUNNING           Currently executing on the server.
COMPLETED         All commands finished successfully.
FAILED            A command exited non-zero (fatal=true), or a connection error occurred.
REJECTED          The human operator rejected the batch.
WAITING_FOR_INPUT The session is blocked waiting for stdin (operator will respond).

IMPORTANT BEHAVIOURS
--------------------
- The human operator may inject commands directly into the session. If this happens,
  session_mutations in the token will contain those commands and their output.
  Reconcile your understanding of server state with these mutations before proceeding.
- If a batch is rejected, check error.human_note for the operator's reason.
- Connections are persistent SSH sessions. You do not need to re-authenticate between batches.
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
      id:       c.id,
      name:     c.name,
      host:     c.host,
      port:     c.port,
      username: c.username,
      status:   c.status,
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
- After calling this, use vigil_poll with the returned token_id to check progress.`,
  {
    connection_id: z.string().describe('ID of the target SSH connection from vigil_list_connections'),
    description:   z.string().min(10).describe('Clear human-readable explanation of what this batch does and why'),
    commands: z.array(z.object({
      command: z.string().min(1).describe('The shell command to run'),
      fatal:   z.boolean().optional().describe('Halt batch on non-zero exit. Defaults to true.'),
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
                     `Poll vigil_poll with token_id "${token.id}" every few seconds until you see a terminal status.`,
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
Call this repeatedly (every few seconds) until status is one of: COMPLETED, FAILED, REJECTED.
On COMPLETED: read output from each command in the commands array.
On FAILED or REJECTED: read the error field and replan — do not blindly retry.
Check session_mutations for any commands the human injected directly into the session.`,
  {
    token_id: z.string().describe('Token ID returned by vigil_enqueue'),
  },
  async ({ token_id }) => {
    const token = getToken(token_id);
    if (!token) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `Token not found: ${token_id}` }) }],
      };
    }

    const terminalStatuses = ['COMPLETED', 'FAILED', 'REJECTED'];
    const isTerminal = terminalStatuses.includes(token.status);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          token_id:          token.id,
          status:            token.status,
          is_terminal:       isTerminal,
          description:       token.description,
          connection_id:     token.connection_id,
          commands:          token.commands,
          error:             token.error ?? null,
          session_mutations: token.session_mutations,
          created_at:        token.created_at,
          updated_at:        token.updated_at,
          approved_at:       token.approved_at ?? null,
          completed_at:      token.completed_at ?? null,
          ...(isTerminal ? {} : { hint: 'Status is not yet terminal. Poll again in a few seconds.' }),
        }, null, 2),
      }],
    };
  }
);

// ─── Tool: queue status ───────────────────────────────────────────────────────

mcpServer.tool(
  'vigil_queue_status',
  'View all active tokens in the queue (PENDING_APPROVAL, APPROVED, RUNNING). Useful for understanding what is currently waiting or in progress.',
  {},
  async () => {
    const active = listTokens(['PENDING_APPROVAL', 'APPROVED', 'RUNNING']);
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
  'Cancel a token that is still PENDING_APPROVAL. Use this if you submitted incorrect commands and want to withdraw them before the human reviews.',
  {
    token_id: z.string().describe('Token ID to cancel'),
    reason:   z.string().optional().describe('Optional reason for cancellation'),
  },
  async ({ token_id, reason }) => {
    try {
      queue.reject(token_id, reason ? `[AI cancelled] ${reason}` : '[AI cancelled]');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, token_id, message: 'Token cancelled.' }) }],
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
