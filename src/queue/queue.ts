import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  createToken,
  getToken,
  getConnection,
  updateTokenStatus,
  updateTokenError,
  updateCommand,
  reconcileStaleTokens,
  logSessionEvent,
} from './store.js';
import type {
  Token,
  Command,
  EnqueueRequest,
  CommandExecutor,
  TokenError,
  SessionMutation,
} from './types.js';

// ─── Events ───────────────────────────────────────────────────────────────────
//
// token:created          → Token          (new token in PENDING_APPROVAL)
// token:approved         → Token          (operator approved)
// token:rejected         → Token          (operator rejected)
// token:started          → Token          (execution began)
// token:command:complete → { token, cmd } (single command finished)
// token:completed        → Token          (all commands succeeded)
// token:failed           → Token          (execution or rejection halted batch)
// token:waiting          → Token          (session is blocked on stdin)

export interface QueueEvents {
  'token:created':          (token: Token) => void;
  'token:approved':         (token: Token) => void;
  'token:rejected':         (token: Token) => void;
  'token:started':          (token: Token) => void;
  'token:command:complete': (payload: { token: Token; command: Command }) => void;
  'token:completed':        (token: Token) => void;
  'token:failed':           (token: Token) => void;
  'token:waiting':          (token: Token) => void;
}

// Stub executor used until the SSH registry is wired in.
const stubExecutor: CommandExecutor = async (_connectionId, command) => {
  console.warn(`[queue] stub executor — command not sent to any server: ${command}`);
  return { output: '[stub] no SSH connection wired', stderr: '', exit_code: 0 };
};

// ─── QueueManager ─────────────────────────────────────────────────────────────

export class QueueManager extends EventEmitter {
  private executor: CommandExecutor;

  // Per-connection FIFO of approved tokens waiting to run.
  // Only one token runs per connection at a time.
  private connectionQueues = new Map<string, Token[]>();
  private busyConnections  = new Set<string>();

  constructor(executor: CommandExecutor = stubExecutor) {
    super();
    this.executor = executor;
  }

  // Call this to swap in the real SSH executor once it's ready.
  setExecutor(executor: CommandExecutor): void {
    this.executor = executor;
  }

  // ─── Startup ───────────────────────────────────────────────────────────────

  init(): void {
    const stale = reconcileStaleTokens();
    if (stale > 0) {
      console.warn(`[queue] ${stale} stale token(s) marked FAILED due to server restart`);
    }
  }

  // ─── Enqueue ───────────────────────────────────────────────────────────────

  enqueue(request: EnqueueRequest): Token {
    const commands: Command[] = request.commands.map((c, i) => ({
      id:    uuidv4(),
      index: i,
      command: c.command,
      fatal: c.fatal ?? true,
    }));

    const token = createToken({
      description:   request.description,
      connection_id: request.connection_id,
      source:        'AI',
      commands,
    });

    console.log(`[queue] enqueued token ${token.id} — "${token.description}" (${commands.length} command(s))`);
    this.emit('token:created', token);

    const conn = getConnection(request.connection_id);
    if (conn?.auto_approve) {
      console.log(`[queue] auto-approving token ${token.id} (connection auto_approve=true)`);
      this.approve(token.id);
      return getToken(token.id)!;
    }

    return token;
  }

  // ─── Approve ───────────────────────────────────────────────────────────────

  approve(tokenId: string): void {
    const token = this.requireToken(tokenId, 'PENDING_APPROVAL');
    const approvedAt = new Date().toISOString();

    updateTokenStatus(tokenId, 'APPROVED', { approved_at: approvedAt });
    const updated = getToken(tokenId)!;

    console.log(`[queue] approved token ${tokenId}`);
    this.emit('token:approved', updated);

    // Push into the per-connection queue and try to start.
    this.enqueueToConnectionQueue(updated);
    this.processConnectionQueue(updated.connection_id);
  }

  // ─── Reject ────────────────────────────────────────────────────────────────

  reject(tokenId: string, humanNote?: string): void {
    const token = this.requireToken(tokenId, 'PENDING_APPROVAL');

    const error: TokenError = { reason: 'REJECTED', human_note: humanNote };
    updateTokenStatus(tokenId, 'REJECTED');
    updateTokenError(tokenId, error);

    const updated = getToken(tokenId)!;
    console.log(`[queue] rejected token ${tokenId}${humanNote ? ` — "${humanNote}"` : ''}`);
    this.emit('token:rejected', updated);
    this.emit('token:failed', updated);
  }

  // ─── Poll ──────────────────────────────────────────────────────────────────

  poll(tokenId: string): Token {
    const token = getToken(tokenId);
    if (!token) throw new Error(`[queue] token not found: ${tokenId}`);
    return token;
  }

  // ─── Human injection ───────────────────────────────────────────────────────
  // Pause the connection queue, log the mutation against the active token (if any),
  // and let the SSH registry execute the command directly.

  async inject(connectionId: string, command: string, activeTokenId?: string): Promise<{
    output: string;
    stderr: string;
    exit_code: number;
  }> {
    console.log(`[queue] human injection on ${connectionId}: ${command}`);

    // Pause further processing on this connection while the human drives.
    this.busyConnections.add(connectionId);

    try {
      const result = await this.executor(connectionId, command);

      // Log to session events.
      logSessionEvent({
        connection_id: connectionId,
        token_id:      activeTokenId,
        command,
        output:        result.output,
        stderr:        result.stderr,
        exit_code:     result.exit_code,
        source:        'HUMAN',
      });

      // If there is an active token, attach the mutation so the AI can reconcile.
      if (activeTokenId) {
        const mutation: SessionMutation = {
          id:        uuidv4(),
          command,
          output:    result.output,
          stderr:    result.stderr,
          source:    'HUMAN',
          timestamp: new Date().toISOString(),
        };
        // Imported dynamically to avoid circular dep
        const { addSessionMutation } = await import('./store.js');
        addSessionMutation(activeTokenId, mutation);
      }

      return result;
    } finally {
      // Release the connection so the queue can resume.
      this.busyConnections.delete(connectionId);
      this.processConnectionQueue(connectionId);
    }
  }

  // ─── Execution ─────────────────────────────────────────────────────────────

  private enqueueToConnectionQueue(token: Token): void {
    if (!this.connectionQueues.has(token.connection_id)) {
      this.connectionQueues.set(token.connection_id, []);
    }
    this.connectionQueues.get(token.connection_id)!.push(token);
  }

  private processConnectionQueue(connectionId: string): void {
    if (this.busyConnections.has(connectionId)) return;

    const queue = this.connectionQueues.get(connectionId);
    if (!queue?.length) return;

    const next = queue.shift()!;
    this.executeToken(next).catch((err) => {
      console.error(`[queue] unhandled execution error for token ${next.id}:`, err);
    });
  }

  private async executeToken(token: Token): Promise<void> {
    this.busyConnections.add(token.connection_id);

    updateTokenStatus(token.id, 'RUNNING');
    const running = getToken(token.id)!;

    console.log(`[queue] executing token ${token.id} on connection ${token.connection_id}`);
    this.emit('token:started', running);

    try {
      for (const command of running.commands) {
        const executedAt = new Date().toISOString();
        updateCommand(token.id, command.index, { executed_at: executedAt });

        let result;
        try {
          result = await this.executor(token.connection_id, command.command);
        } catch (err) {
          // Executor itself threw — treat as connection error.
          const error: TokenError = {
            reason:         'CONNECTION_ERROR',
            interrupted_at: command.index,
            command:        command.command,
            stderr:         String(err),
          };
          updateTokenStatus(token.id, 'FAILED');
          updateTokenError(token.id, error);
          const failed = getToken(token.id)!;
          this.emit('token:failed', failed);
          return;
        }

        const completedAt = new Date().toISOString();
        updateCommand(token.id, command.index, {
          output:       result.output,
          stderr:       result.stderr,
          exit_code:    result.exit_code,
          completed_at: completedAt,
        });

        // Log to session audit trail.
        logSessionEvent({
          connection_id: token.connection_id,
          token_id:      token.id,
          command:       command.command,
          output:        result.output,
          stderr:        result.stderr,
          exit_code:     result.exit_code,
          source:        'AI',
        });

        const afterCommand = getToken(token.id)!;
        this.emit('token:command:complete', {
          token:   afterCommand,
          command: afterCommand.commands[command.index],
        });

        // Non-zero exit on a fatal command halts the batch.
        if (result.exit_code !== 0 && command.fatal) {
          const error: TokenError = {
            reason:         'EXEC_FAILURE',
            interrupted_at: command.index,
            command:        command.command,
            stderr:         result.stderr,
            exit_code:      result.exit_code,
          };
          updateTokenStatus(token.id, 'FAILED');
          updateTokenError(token.id, error);
          const failed = getToken(token.id)!;
          console.warn(`[queue] token ${token.id} FAILED at command ${command.index}: exit ${result.exit_code}`);
          this.emit('token:failed', failed);
          return;
        }
      }

      // All commands passed.
      updateTokenStatus(token.id, 'COMPLETED', { completed_at: new Date().toISOString() });
      const completed = getToken(token.id)!;
      console.log(`[queue] token ${token.id} COMPLETED`);
      this.emit('token:completed', completed);

    } finally {
      this.busyConnections.delete(token.connection_id);
      // Always try to drain the next item for this connection.
      this.processConnectionQueue(token.connection_id);
    }
  }

  // ─── Utils ─────────────────────────────────────────────────────────────────

  private requireToken(id: string, expectedStatus: Token['status']): Token {
    const token = getToken(id);
    if (!token)                         throw new Error(`[queue] token not found: ${id}`);
    if (token.status !== expectedStatus) throw new Error(`[queue] token ${id} has status ${token.status}, expected ${expectedStatus}`);
    return token;
  }
}

// Singleton — imported by MCP, API, and WebSocket layers.
export const queue = new QueueManager();
