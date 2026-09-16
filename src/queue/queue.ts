import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import {
  createToken,
  getToken,
  getConnection,
  listTokens,
  updateTokenStatus,
  updateTokenError,
  updateCommand,
  reconcileStaleTokens,
  logSessionEvent,
  addSessionMutation,
  setWaitingForInput,
  setInputRequests,
  setTokenRecovered,
} from './store.js';
import { RunDetachedError } from './types.js';
import type {
  Token,
  Command,
  EnqueueRequest,
  CommandRunner,
  ExecOptions,
  ExecResult,
  InputRequest,
  RemoteRun,
  RemoteRunInfo,
  StopCause,
  TokenError,
  TokenSource,
  SessionMutation,
} from './types.js';

// ─── Events ───────────────────────────────────────────────────────────────────
//
// token:created          → Token          (new token in PENDING_APPROVAL)
// token:approved         → Token          (operator approved)
// token:rejected         → Token          (operator rejected)
// token:started          → Token          (execution began)
// token:command:output   → { token_id, command_index, chunk } (live output)
// token:command:complete → { token, cmd } (single command finished)
// token:completed        → Token          (all commands succeeded)
// token:failed           → Token          (execution or rejection halted batch)
// token:waiting          → Token          (command is blocked on stdin)
// token:running          → Token          (command resumed after waiting)
// token:input:requested  → Token          (AI input awaiting operator approval)
// token:input:resolved   → Token          (input request sent/rejected/expired)
// token:recovered        → Token          (reattached to a run after restart/disconnect)

export interface QueueEvents {
  'token:created':          (token: Token) => void;
  'token:approved':         (token: Token) => void;
  'token:rejected':         (token: Token) => void;
  'token:started':          (token: Token) => void;
  'token:command:output':   (payload: { token_id: string; command_index: number; chunk: string }) => void;
  'token:command:complete': (payload: { token: Token; command: Command }) => void;
  'token:completed':        (token: Token) => void;
  'token:failed':           (token: Token) => void;
  'token:waiting':          (token: Token) => void;
  'token:running':          (token: Token) => void;
  'token:input:requested':  (token: Token) => void;
  'token:input:resolved':   (token: Token) => void;
  'token:recovered':        (token: Token) => void;
}

// Events that mean "something about this token changed" — used by waitForChange.
const CHANGE_EVENTS = [
  'token:approved', 'token:rejected', 'token:started', 'token:completed', 'token:failed',
  'token:waiting', 'token:running', 'token:input:requested', 'token:input:resolved', 'token:recovered',
  'token:command:complete',
] as const;

export const TERMINAL_STATUSES: Token['status'][] = ['COMPLETED', 'FAILED', 'REJECTED'];

const OUTPUT_FLUSH_MS = 500;

// Stub runner used until the SSH registry is wired in.
const notWired = async (): Promise<never> => {
  throw new Error('[queue] no command runner wired');
};
const stubRunner: CommandRunner = {
  ensureConnected: notWired,
  exec: async (_connectionId, command) => {
    console.warn(`[queue] stub runner — command not sent to any server: ${command}`);
    return { output: '[stub] no SSH connection wired', stderr: '', exit_code: 0 };
  },
  recover:       notWired,
  stop:          async () => false,
  sendInput:     notWired,
  cleanupRun:    async () => {},
  readRunOutput: notWired,
  listRuns:      async () => [],
  stopRun:       notWired,
};

// State for the token currently executing on a connection.
interface ActiveExecution {
  tokenId:        string;
  commandIndex:   number;
  stopRequested?: StopCause;
  output:         string;   // live output of the current command (capped)
  pendingChunk:   string;
  flushTimer?:    ReturnType<typeof setTimeout>;
}

// ─── QueueManager ─────────────────────────────────────────────────────────────

export class QueueManager extends EventEmitter {
  private runner: CommandRunner;

  // Per-connection FIFO of approved tokens waiting to run.
  // Only one token runs per connection at a time.
  private connectionQueues = new Map<string, Token[]>();
  private busyConnections  = new Set<string>();
  private active           = new Map<string, ActiveExecution>();

  constructor(runner: CommandRunner = stubRunner) {
    super();
    this.runner = runner;
    this.setMaxListeners(0); // vigil_wait subscribes per call

    // Collect results of runs left behind by earlier sessions, and tidy up.
    this.on('connection:connected', (connectionId: string) => {
      this.reconcileRuns(connectionId).catch((err) => {
        console.warn(`[queue] run reconciliation failed for ${connectionId}: ${(err as Error).message}`);
      });
    });
  }

  // Call this to swap in the real SSH runner once it's ready.
  setRunner(runner: CommandRunner): void {
    this.runner = runner;
  }

  // ─── Startup ───────────────────────────────────────────────────────────────

  // Must run after the real runner is wired: in-flight tokens are reattached.
  init(): void {
    const stale = reconcileStaleTokens();
    if (stale > 0) {
      console.warn(`[queue] ${stale} queued token(s) marked FAILED due to server restart`);
    }

    for (const token of listTokens(['RUNNING', 'WAITING_FOR_INPUT'])) {
      const cmd = token.commands.find((c) => c.executed_at && !c.completed_at);

      if (!cmd?.remote_run) {
        updateTokenStatus(token.id, 'FAILED');
        updateTokenError(token.id, {
          reason: 'SERVER_RESTART',
          interrupted_at: cmd?.index,
          command: cmd?.command,
          note: 'the command was not tracked on the host, so it could not be recovered',
        });
        setWaitingForInput(token.id, null);
        console.warn(`[queue] token ${token.id} marked FAILED due to server restart (untracked run)`);
        continue;
      }

      console.log(`[queue] recovering token ${token.id} (command ${cmd.index} in ${cmd.remote_run.dir})`);
      this.executeToken(token, { index: cmd.index, run: cmd.remote_run }).catch((err) => {
        console.error(`[queue] unhandled recovery error for token ${token.id}:`, err);
      });
    }
  }

  // ─── Enqueue ───────────────────────────────────────────────────────────────

  enqueue(request: EnqueueRequest): Token {
    const commands: Command[] = request.commands.map((c, i) => ({
      id:    uuidv4(),
      index: i,
      command: c.command,
      fatal: c.fatal ?? true,
      ...(c.timeout_seconds ? { timeout_seconds: c.timeout_seconds } : {}),
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
    this.requireToken(tokenId, 'PENDING_APPROVAL');
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
    this.requireToken(tokenId, 'PENDING_APPROVAL');

    const error: TokenError = { reason: 'REJECTED', human_note: humanNote };
    updateTokenStatus(tokenId, 'REJECTED');
    updateTokenError(tokenId, error);

    const updated = getToken(tokenId)!;
    console.log(`[queue] rejected token ${tokenId}${humanNote ? ` — "${humanNote}"` : ''}`);
    this.emit('token:rejected', updated);
    this.emit('token:failed', updated);
  }

  // ─── Cancel / Stop ─────────────────────────────────────────────────────────

  // Withdraw a token at any non-terminal stage: reject if pending, dequeue if
  // approved, stop if running.
  async cancel(tokenId: string, source: TokenSource, note?: string): Promise<Token> {
    const token = getToken(tokenId);
    if (!token) throw new Error(`[queue] token not found: ${tokenId}`);

    switch (token.status) {
      case 'PENDING_APPROVAL':
        this.reject(tokenId, note);
        break;

      case 'APPROVED': {
        const queue = this.connectionQueues.get(token.connection_id) ?? [];
        this.connectionQueues.set(token.connection_id, queue.filter((t) => t.id !== tokenId));
        updateTokenStatus(tokenId, 'REJECTED');
        updateTokenError(tokenId, { reason: 'REJECTED', human_note: note });
        const updated = getToken(tokenId)!;
        console.log(`[queue] cancelled queued token ${tokenId}`);
        this.emit('token:rejected', updated);
        this.emit('token:failed', updated);
        break;
      }

      case 'RUNNING':
      case 'WAITING_FOR_INPUT':
        await this.stop(tokenId, source);
        break;

      default:
        throw new Error(`[queue] token ${tokenId} is already ${token.status}`);
    }

    return getToken(tokenId)!;
  }

  // Stop the running command (SIGINT → SIGTERM → SIGKILL). Resolves once the
  // stop has been initiated; the token turns FAILED/STOPPED when it exits.
  async stop(tokenId: string, source: TokenSource): Promise<void> {
    const token = getToken(tokenId);
    if (!token) throw new Error(`[queue] token not found: ${tokenId}`);
    if (token.status !== 'RUNNING' && token.status !== 'WAITING_FOR_INPUT') {
      throw new Error(`[queue] token ${tokenId} is not running (status ${token.status})`);
    }

    const exec = this.active.get(token.connection_id);
    if (!exec || exec.tokenId !== tokenId) {
      throw new Error(`[queue] token ${tokenId} is not currently executing`);
    }

    console.log(`[queue] stop requested for token ${tokenId} by ${source}`);
    exec.stopRequested = exec.stopRequested ?? source;
    // If nothing is running right now (between commands, or still connecting),
    // the flag halts the batch before the next command starts.
    await this.runner.stop(token.connection_id, source);
  }

  // ─── Poll / wait ───────────────────────────────────────────────────────────

  poll(tokenId: string): Token {
    const token = getToken(tokenId);
    if (!token) throw new Error(`[queue] token not found: ${tokenId}`);
    return token;
  }

  // Resolve when the token changes state (or after timeoutMs).
  waitForChange(tokenId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const handler = (payload: Token | { token: Token }) => {
        const token = 'token' in payload ? payload.token : payload;
        if (token.id === tokenId) done();
      };
      const done = () => {
        clearTimeout(timer);
        for (const ev of CHANGE_EVENTS) this.off(ev, handler);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      for (const ev of CHANGE_EVENTS) this.on(ev, handler);
    });
  }

  // ─── Input ─────────────────────────────────────────────────────────────────

  // HUMAN input is delivered immediately. AI input needs operator approval
  // unless the connection auto-approves commands or input.
  async sendInput(
    tokenId: string,
    input: { data: string; newline?: boolean; eof?: boolean; secret?: boolean },
    source: TokenSource,
  ): Promise<InputRequest> {
    const token = getToken(tokenId);
    if (!token) throw new Error(`[queue] token not found: ${tokenId}`);
    if (token.status !== 'RUNNING' && token.status !== 'WAITING_FOR_INPUT') {
      throw new Error(`[queue] token ${tokenId} is not running (status ${token.status})`);
    }
    const exec = this.active.get(token.connection_id);
    if (!exec || exec.tokenId !== tokenId) throw new Error(`[queue] token ${tokenId} is not currently executing`);

    const secret  = source === 'HUMAN' && Boolean(input.secret);
    const request: InputRequest = {
      id:            uuidv4(),
      command_index: exec.commandIndex,
      data:          input.data ?? '',
      newline:       input.newline ?? true,
      eof:           Boolean(input.eof),
      secret,
      source,
      status:        'PENDING',
      created_at:    new Date().toISOString(),
    };

    if (source === 'AI' && !this.inputAutoApproved(token.connection_id)) {
      setInputRequests(tokenId, [...token.input_requests, request]);
      console.log(`[queue] AI input for token ${tokenId} awaiting approval`);
      this.emit('token:input:requested', getToken(tokenId)!);
      return request;
    }

    return this.deliverInput(tokenId, request);
  }

  async approveInput(tokenId: string, requestId: string): Promise<InputRequest> {
    const token   = getToken(tokenId);
    const request = token?.input_requests.find((r) => r.id === requestId);
    if (!token || !request) throw new Error(`[queue] input request not found: ${requestId}`);
    if (request.status !== 'PENDING') throw new Error(`[queue] input request is already ${request.status}`);

    const exec = this.active.get(token.connection_id);
    if (!exec || exec.tokenId !== tokenId || exec.commandIndex !== request.command_index) {
      return this.resolveInput(tokenId, request, 'EXPIRED', 'the command it was meant for is no longer running');
    }
    return this.deliverInput(tokenId, request);
  }

  rejectInput(tokenId: string, requestId: string): InputRequest {
    const token   = getToken(tokenId);
    const request = token?.input_requests.find((r) => r.id === requestId);
    if (!token || !request) throw new Error(`[queue] input request not found: ${requestId}`);
    if (request.status !== 'PENDING') throw new Error(`[queue] input request is already ${request.status}`);
    return this.resolveInput(tokenId, request, 'REJECTED');
  }

  inputAutoApproved(connectionId: string): boolean {
    const conn = getConnection(connectionId);
    return Boolean(conn?.auto_approve || conn?.auto_approve_input);
  }

  private async deliverInput(tokenId: string, request: InputRequest): Promise<InputRequest> {
    const token   = getToken(tokenId)!;
    // A bare EOF shouldn't also send an empty line.
    const newline = request.newline && !(request.eof && request.data === '');
    const payload = request.data + (newline ? '\n' : '');

    try {
      await this.runner.sendInput(token.connection_id, payload, request.eof);
    } catch (err) {
      return this.resolveInput(tokenId, request, 'FAILED', (err as Error).message);
    }

    logSessionEvent({
      connection_id: token.connection_id,
      token_id:      tokenId,
      command:       `<stdin>${request.eof ? ' <EOF>' : ''}`,
      output:        request.secret ? '[redacted]' : request.data,
      source:        request.source,
    });

    return this.resolveInput(tokenId, request, 'SENT');
  }

  private resolveInput(
    tokenId: string,
    request: InputRequest,
    status: InputRequest['status'],
    error?: string,
  ): InputRequest {
    const token    = getToken(tokenId)!;
    const resolved: InputRequest = {
      ...request,
      data:        request.secret ? '[redacted]' : request.data,
      status,
      resolved_at: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
    const exists   = token.input_requests.some((r) => r.id === request.id);
    const requests = exists
      ? token.input_requests.map((r) => (r.id === request.id ? resolved : r))
      : [...token.input_requests, resolved];
    setInputRequests(tokenId, requests);

    console.log(`[queue] input for token ${tokenId} ${status}${error ? ` — ${error}` : ''}`);
    this.emit('token:input:resolved', getToken(tokenId)!);
    return resolved;
  }

  // Pending requests are tied to a specific command; expire them when it ends.
  private expirePendingInput(tokenId: string): void {
    const token = getToken(tokenId);
    if (!token?.input_requests.some((r) => r.status === 'PENDING')) return;

    const now = new Date().toISOString();
    setInputRequests(tokenId, token.input_requests.map((r) =>
      r.status === 'PENDING'
        ? { ...r, status: 'EXPIRED', resolved_at: now, error: 'the command finished before the input was approved' }
        : r,
    ));
    this.emit('token:input:resolved', getToken(tokenId)!);
  }

  // ─── Human injection ───────────────────────────────────────────────────────
  // Run a command directly on an idle connection, logging the mutation against
  // the given token (if any) so the AI can reconcile.

  async inject(connectionId: string, command: string, activeTokenId?: string): Promise<{
    output: string;
    stderr: string;
    exit_code: number;
  }> {
    if (this.busyConnections.has(connectionId)) {
      throw new Error('[queue] connection busy — stop the running token or wait for it to finish');
    }

    console.log(`[queue] human injection on ${connectionId}: ${command}`);

    // Pause further processing on this connection while the human drives.
    this.busyConnections.add(connectionId);

    try {
      const result = await this.runner.exec(connectionId, command, {
        name: `inject-${uuidv4().slice(0, 8)}`,
      });
      if (result.run) this.cleanupRun(connectionId, result.run);

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
        addSessionMutation(activeTokenId, mutation);
      }

      return result;
    } finally {
      // Release the connection so the queue can resume.
      this.busyConnections.delete(connectionId);
      this.processConnectionQueue(connectionId);
    }
  }

  // ─── Orphaned runs ─────────────────────────────────────────────────────────

  async listOrphans(connectionId: string): Promise<RemoteRunInfo[]> {
    const referenced = this.referencedRunDirs(connectionId);
    const runs = await this.runner.listRuns(connectionId);
    return runs.filter((r) => !referenced.has(r.dir));
  }

  async stopOrphan(connectionId: string, name: string): Promise<void> {
    const orphan = (await this.listOrphans(connectionId)).find((r) => r.name === name);
    if (!orphan) throw new Error(`[queue] orphaned run not found: ${name}`);
    await this.runner.stopRun(connectionId, orphan);
    console.log(`[queue] stopped and removed orphaned run ${orphan.dir}`);
  }

  private referencedRunDirs(connectionId: string): Set<string> {
    const dirs = new Set<string>();
    for (const token of listTokens(['RUNNING', 'WAITING_FOR_INPUT'])) {
      if (token.connection_id !== connectionId) continue;
      for (const cmd of token.commands) {
        if (cmd.remote_run && !cmd.completed_at) dirs.add(cmd.remote_run.dir);
      }
    }
    return dirs;
  }

  // Finished runs no token is waiting on: attach results to tokens that lost
  // them (SESSION_LOST) and delete the directories. Live ones are left alone
  // and surface as orphans.
  private async reconcileRuns(connectionId: string): Promise<void> {
    const orphans = await this.listOrphans(connectionId);

    for (const orphan of orphans) {
      if (orphan.state === 'alive') {
        console.warn(`[queue] orphaned run still alive on ${connectionId}: ${orphan.dir}`);
        continue;
      }

      const match = orphan.name.match(/^([0-9a-f-]{36})-(\d+)$/);
      const token = match ? getToken(match[1]) : undefined;
      const index = match ? parseInt(match[2], 10) : -1;
      const cmd   = token?.commands[index];

      if (token && cmd && !cmd.completed_at && token.error?.reason === 'SESSION_LOST') {
        try {
          const output = await this.runner.readRunOutput(connectionId, orphan.dir);
          updateCommand(token.id, index, {
            output,
            exit_code:    orphan.exit_code,
            completed_at: new Date().toISOString(),
          });
          updateTokenError(token.id, {
            ...token.error,
            note: `${token.error.note ? token.error.note + '; ' : ''}` +
                  `result collected on reconnect (exit ${orphan.exit_code ?? 'unknown'})`,
          });
          const updated = getToken(token.id)!;
          this.emit('token:command:complete', { token: updated, command: updated.commands[index] });
          console.log(`[queue] collected late result for token ${token.id} command ${index}`);
        } catch (err) {
          console.warn(`[queue] could not collect result from ${orphan.dir}: ${(err as Error).message}`);
          continue;
        }
      }

      await this.runner.cleanupRun(connectionId, orphan.dir).catch(() => {});
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

  // `resume` reattaches to an in-flight command (after a restart) instead of
  // starting from the first command.
  private async executeToken(token: Token, resume?: { index: number; run: RemoteRun }): Promise<void> {
    const connectionId = token.connection_id;
    this.busyConnections.add(connectionId);

    const exec: ActiveExecution = { tokenId: token.id, commandIndex: resume?.index ?? 0, output: '', pendingChunk: '' };
    this.active.set(connectionId, exec);

    updateTokenStatus(token.id, 'RUNNING');
    setWaitingForInput(token.id, null);
    const running = getToken(token.id)!;

    if (resume) {
      console.log(`[queue] resuming token ${token.id} on connection ${connectionId}`);
    } else {
      console.log(`[queue] executing token ${token.id} on connection ${connectionId}`);
      this.emit('token:started', running);
    }

    try {
      for (const command of running.commands) {
        if (resume && command.index < resume.index) continue;

        if (exec.stopRequested) {
          this.failToken(token.id, {
            reason:         'STOPPED',
            interrupted_at: command.index,
            command:        command.command,
            stopped_by:     exec.stopRequested,
          });
          return;
        }

        exec.commandIndex = command.index;
        exec.output       = '';
        exec.pendingChunk = '';

        const isResumed = resume?.index === command.index;
        if (!isResumed) {
          updateCommand(token.id, command.index, { executed_at: new Date().toISOString() });
        }

        let result: ExecResult;
        let recovered = isResumed;

        try {
          result = isResumed
            ? await this.recoverCommand(token.id, command, resume!.run, exec)
            : await this.runner.exec(connectionId, command.command, this.execOptions(token.id, command, exec));
        } catch (err) {
          if (err instanceof RunDetachedError) {
            console.warn(`[queue] connection lost during token ${token.id}; attempting to reattach`);
            recovered = true;
            result    = await this.recoverCommand(token.id, command, err.run, exec);
          } else {
            // Executor itself threw — treat as connection error.
            this.flushOutput(token.id, exec);
            this.failToken(token.id, {
              reason:         'CONNECTION_ERROR',
              interrupted_at: command.index,
              command:        command.command,
              stderr:         String(err),
            });
            return;
          }
        }

        const proceed = this.finishCommand(token.id, command, result, exec);
        if (!proceed) return;

        // A reattached run finished in a shell we no longer own — cwd/env from
        // earlier commands are gone, so don't run the rest of the batch.
        if (recovered && command.index < running.commands.length - 1) {
          this.failToken(token.id, {
            reason:         'SESSION_LOST',
            interrupted_at: command.index + 1,
            command:        running.commands[command.index + 1].command,
            note:           'the SSH session was lost mid-batch; the in-flight command was recovered but ' +
                            'the remaining commands were not run (shell state such as cwd/env is gone)',
          });
          return;
        }
      }

      // All commands passed.
      updateTokenStatus(token.id, 'COMPLETED', { completed_at: new Date().toISOString() });
      const completed = getToken(token.id)!;
      console.log(`[queue] token ${token.id} COMPLETED`);
      this.emit('token:completed', completed);

    } finally {
      this.flushOutput(token.id, exec);
      if (this.active.get(connectionId) === exec) this.active.delete(connectionId);
      setWaitingForInput(token.id, null);
      this.expirePendingInput(token.id);
      this.busyConnections.delete(connectionId);
      // Always try to drain the next item for this connection.
      this.processConnectionQueue(connectionId);
    }
  }

  // Record a finished command. Returns false if the batch must halt.
  private finishCommand(tokenId: string, command: Command, result: ExecResult, exec: ActiveExecution): boolean {
    this.flushOutput(tokenId, exec);
    this.clearWaiting(tokenId);
    this.expirePendingInput(tokenId);

    updateCommand(tokenId, command.index, {
      output:       result.output,
      stderr:       result.stderr,
      exit_code:    result.exit_code,
      completed_at: new Date().toISOString(),
    });

    const token = getToken(tokenId)!;

    // Log to session audit trail.
    logSessionEvent({
      connection_id: token.connection_id,
      token_id:      tokenId,
      command:       command.command,
      output:        result.output,
      stderr:        result.stderr,
      exit_code:     result.exit_code,
      source:        'AI',
    });

    // Output is persisted — the run dir on the host can go.
    const run = result.run ?? token.commands[command.index].remote_run;
    if (run && !result.lost) this.cleanupRun(token.connection_id, run);

    this.emit('token:command:complete', {
      token:   token,
      command: token.commands[command.index],
    });

    if (result.stopped_by) {
      this.failToken(tokenId, {
        reason:         result.stopped_by === 'TIMEOUT' ? 'TIMEOUT' : 'STOPPED',
        interrupted_at: command.index,
        command:        command.command,
        exit_code:      result.exit_code,
        stopped_by:     result.stopped_by,
        session_reset:  result.session_reset,
        note:           result.note,
      });
      return false;
    }

    if (result.lost) {
      this.failToken(tokenId, {
        reason:         'SESSION_LOST',
        interrupted_at: command.index,
        command:        command.command,
        note:           result.note,
      });
      return false;
    }

    // Non-zero exit on a fatal command halts the batch.
    if (result.exit_code !== 0 && command.fatal) {
      this.failToken(tokenId, {
        reason:         'EXEC_FAILURE',
        interrupted_at: command.index,
        command:        command.command,
        stderr:         result.stderr,
        exit_code:      result.exit_code,
      });
      console.warn(`[queue] token ${tokenId} FAILED at command ${command.index}: exit ${result.exit_code}`);
      return false;
    }

    return true;
  }

  // Reconnect (with backoff) and reattach to a run that outlived its session.
  private async recoverCommand(
    tokenId: string,
    command: Command,
    run: RemoteRun,
    exec: ActiveExecution,
  ): Promise<ExecResult> {
    const token = getToken(tokenId)!;
    if (!token.recovered) setTokenRecovered(tokenId, true);

    const deadline = Date.now() + config.recoveryTimeoutMs;
    let delay = 2000;

    for (;;) {
      if (exec.stopRequested) {
        return {
          output: exec.output, stderr: '', exit_code: -1, lost: true, stopped_by: exec.stopRequested,
          note: `stopped before reattaching; the command may still be running on the host in ${run.dir}`,
        };
      }
      try {
        await this.runner.ensureConnected(token.connection_id);
        break;
      } catch (err) {
        if (Date.now() + delay > deadline) {
          return {
            output: exec.output, stderr: '', exit_code: -1, lost: true,
            note: `could not reconnect to reattach (${(err as Error).message}); ` +
                  `the run was left on the host at ${run.dir} and will be collected on the next connect`,
          };
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
      }
    }

    try {
      // The reattached tail replays the output log, so start the command's output afresh.
      exec.output = '';
      exec.pendingChunk = '';
      updateCommand(tokenId, command.index, { output: '' });
      this.emit('token:recovered', getToken(tokenId)!);
      return await this.runner.recover(token.connection_id, run, this.execOptions(tokenId, command, exec));
    } catch (err) {
      if (err instanceof RunDetachedError) {
        // Dropped again while reattached — try again within the same budget.
        return this.recoverCommand(tokenId, command, err.run, exec);
      }
      return {
        output: exec.output, stderr: '', exit_code: -1, lost: true,
        note: `failed to reattach: ${(err as Error).message}`,
      };
    }
  }

  private execOptions(tokenId: string, command: Command, exec: ActiveExecution): ExecOptions {
    return {
      name:      `${tokenId}-${command.index}`,
      timeoutMs: command.timeout_seconds ? command.timeout_seconds * 1000 : undefined,
      isAborted: () => exec.stopRequested,

      onRunStarted: (run) => {
        updateCommand(tokenId, command.index, { remote_run: run });
      },

      onOutput: (chunk) => {
        const max = config.outputMaxBytes;
        exec.output += chunk;
        if (exec.output.length > max) exec.output = exec.output.slice(-max);
        exec.pendingChunk += chunk;
        if (!exec.flushTimer) {
          exec.flushTimer = setTimeout(() => this.flushOutput(tokenId, exec), OUTPUT_FLUSH_MS);
        }
      },

      onWaiting: (info) => {
        const token = getToken(tokenId);
        if (!token || TERMINAL_STATUSES.includes(token.status)) return;

        if (info) {
          this.flushOutput(tokenId, exec);
          updateTokenStatus(tokenId, 'WAITING_FOR_INPUT');
          setWaitingForInput(tokenId, {
            command_index: command.index,
            prompt:        info.prompt,
            recent_output: info.recent_output,
            since:         new Date().toISOString(),
          });
          console.log(`[queue] token ${tokenId} waiting for input: ${JSON.stringify(info.prompt)}`);
          this.emit('token:waiting', getToken(tokenId)!);
        } else {
          this.clearWaiting(tokenId);
        }
      },
    };
  }

  private clearWaiting(tokenId: string): void {
    const token = getToken(tokenId);
    if (!token || token.status !== 'WAITING_FOR_INPUT') return;
    updateTokenStatus(tokenId, 'RUNNING');
    setWaitingForInput(tokenId, null);
    this.emit('token:running', getToken(tokenId)!);
  }

  // Persist live output and push the accumulated chunk to the UI.
  private flushOutput(tokenId: string, exec: ActiveExecution): void {
    if (exec.flushTimer) {
      clearTimeout(exec.flushTimer);
      exec.flushTimer = undefined;
    }
    if (!exec.pendingChunk) return;

    const chunk = exec.pendingChunk;
    exec.pendingChunk = '';

    const token = getToken(tokenId);
    if (!token || TERMINAL_STATUSES.includes(token.status)) return;

    updateCommand(tokenId, exec.commandIndex, { output: exec.output });
    this.emit('token:command:output', { token_id: tokenId, command_index: exec.commandIndex, chunk });
  }

  private failToken(tokenId: string, error: TokenError): void {
    updateTokenStatus(tokenId, 'FAILED');
    updateTokenError(tokenId, error);
    setWaitingForInput(tokenId, null);
    const failed = getToken(tokenId)!;
    console.warn(`[queue] token ${tokenId} FAILED (${error.reason})`);
    this.emit('token:failed', failed);
  }

  private cleanupRun(connectionId: string, run: RemoteRun): void {
    this.runner.cleanupRun(connectionId, run.dir).catch((err) => {
      console.warn(`[queue] failed to clean up ${run.dir}: ${(err as Error).message}`);
    });
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
