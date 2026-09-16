import { EventEmitter } from 'events';
import {
  getConnection,
  updateConnectionStatus,
} from '../queue/store.js';
import { RunDetachedError } from '../queue/types.js';
import type {
  CommandRunner,
  ExecOptions,
  ExecResult,
  RemoteRun,
  RemoteRunInfo,
  StopCause,
} from '../queue/types.js';
import { CommandRun } from './command-run.js';
import type { RunHooks } from './command-run.js';
import * as ops from './remote-ops.js';
import type { Signal } from './remote-ops.js';
import { isRunDir, isRunName } from './shell-protocol.js';
import { ShellSession, dbg } from './shell-session.js';
import type { CloseOptions } from './shell-session.js';

// Owns one ShellSession and at most one CommandRun per connection, and
// implements the queue's CommandRunner on top of them.
//
// Events: 'connection:connected' | 'connection:disconnected' (id),
//         'connection:error' (id, err)
export class SshRegistry extends EventEmitter implements CommandRunner {
  private sessions   = new Map<string, ShellSession>();
  private connecting = new Map<string, Promise<ShellSession>>();
  private runs       = new Map<string, CommandRun>();
  // Run dirs whose results haven't been persisted yet — never reconciled away.
  private unpersisted = new Set<string>();

  private readonly runHooks: RunHooks = {
    onSettled: (run, { result, error }) => {
      if (this.runs.get(run.connectionId) === run) this.runs.delete(run.connectionId);
      // Keep the dir until the queue saves the result — or reattaches, if detached.
      const keep = result ? !result.lost : error instanceof RunDetachedError;
      if (run.remote && keep) this.unpersisted.add(run.remote.dir);
    },
    onUnstoppable: (run) => {
      console.warn(`[ssh] command did not exit after SIGKILL — resetting session ${run.connectionId}`);
      run.session.close('stop escalation failed');
    },
  };

  // ─── Connect / disconnect ──────────────────────────────────────────────────

  async connect(connectionId: string): Promise<void> {
    await this.session(connectionId);
  }

  ensureConnected(connectionId: string): Promise<void> {
    return this.connect(connectionId);
  }

  async disconnect(connectionId: string): Promise<void> {
    this.sessions.get(connectionId)?.close('disconnected by request', { detach: false });
  }

  private session(connectionId: string): Promise<ShellSession> {
    const open = this.sessions.get(connectionId);
    if (open) return Promise.resolve(open);

    let pending = this.connecting.get(connectionId);
    if (!pending) {
      pending = this.openSession(connectionId).finally(() => this.connecting.delete(connectionId));
      this.connecting.set(connectionId, pending);
    }
    return pending;
  }

  private async openSession(connectionId: string): Promise<ShellSession> {
    const conn = getConnection(connectionId);
    if (!conn) throw new Error(`[ssh] connection not found: ${connectionId}`);

    let session: ShellSession;
    try {
      session = await ShellSession.open(conn);
    } catch (err) {
      updateConnectionStatus(connectionId, 'ERROR', { error: (err as Error).message });
      this.emit('connection:error', connectionId, err);
      throw err;
    }

    session.on('data', (text: string) => {
      const run = this.runs.get(connectionId);
      if (run && run.session === session) run.handleShellData(text);
      else dbg(connectionId, 'unexpected shell output', text);
    });

    session.on('clientError', (err: Error) => {
      updateConnectionStatus(connectionId, 'ERROR', { error: err.message });
      this.emit('connection:error', connectionId, err);
    });

    session.on('close', (reason: string, opts: CloseOptions) => this.sessionClosed(session, reason, opts));

    this.sessions.set(connectionId, session);
    updateConnectionStatus(connectionId, 'CONNECTED', { last_connected_at: new Date().toISOString() });
    console.log(`[ssh] connected: ${conn.name} @ ${conn.host}:${conn.port} (shell pid ${session.shellPid})`);
    this.emit('connection:connected', connectionId);
    return session;
  }

  // Only acts on state belonging to `session`, so a late close of an old
  // session can't tear down its replacement.
  private sessionClosed(session: ShellSession, reason: string, opts: CloseOptions): void {
    const connectionId = session.connectionId;

    if (this.sessions.get(connectionId) === session) {
      this.sessions.delete(connectionId);
      if (!opts.error) updateConnectionStatus(connectionId, 'DISCONNECTED');
      console.log(`[ssh] session closed: ${connectionId} (${reason})`);
      this.emit('connection:disconnected', connectionId);
    }

    const run = this.runs.get(connectionId);
    if (run && run.session === session) run.sessionClosed(reason, opts);
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  async exec(connectionId: string, command: string, opts: ExecOptions): Promise<ExecResult> {
    const session = await this.session(connectionId);
    this.assertIdle(connectionId);
    if (!isRunName(opts.name)) throw new Error(`[ssh] invalid run name: ${opts.name}`);

    const aborted = opts.isAborted?.();
    if (aborted) return { output: '', stderr: '', exit_code: -1, stopped_by: aborted };

    const run = CommandRun.start(session, command, opts, this.runHooks);
    this.runs.set(connectionId, run);
    return run.result;
  }

  // Reattach to a run that outlived its session (restart / dropped connection).
  async recover(connectionId: string, remote: RemoteRun, opts: ExecOptions): Promise<ExecResult> {
    const session = await this.session(connectionId);
    this.assertIdle(connectionId);

    const info = await ops.inspectRun(session, remote);

    switch (info.state) {
      case 'missing':
        return { output: '', stderr: '', exit_code: -1, lost: true, run: remote,
                 note: `run directory ${remote.dir} no longer exists on the host` };

      case 'exited': {
        this.unpersisted.add(remote.dir);
        const output = await ops.readOutput(session, remote.dir);
        return { output, stderr: '', exit_code: info.exit_code ?? -1, run: remote };
      }

      case 'dead': {
        const output = await ops.readOutput(session, remote.dir);
        return { output, stderr: '', exit_code: -1, lost: true, run: remote,
                 note: 'the command was no longer running and did not record an exit code' };
      }

      case 'alive': {
        const run = CommandRun.reattach(session, remote, info.size, opts, this.runHooks);
        this.runs.set(connectionId, run);
        console.log(`[ssh] reattached to running command in ${remote.dir} on ${connectionId}`);
        return run.result;
      }
    }
  }

  async stop(connectionId: string, cause: StopCause): Promise<boolean> {
    const run = this.runs.get(connectionId);
    if (!run || run.isSettled) return false;
    run.stop(cause);
    return true;
  }

  async sendInput(connectionId: string, data: string, eof: boolean): Promise<void> {
    const run = this.runs.get(connectionId);
    if (!run) throw new Error('no running command to send input to');
    await run.sendInput(data, eof);
  }

  private assertIdle(connectionId: string): void {
    if (this.runs.has(connectionId)) throw new Error(`[ssh] session is busy: ${connectionId}`);
  }

  // ─── Run directories ───────────────────────────────────────────────────────

  async cleanupRun(connectionId: string, dir: string): Promise<void> {
    this.unpersisted.delete(dir);
    const session = this.sessions.get(connectionId);
    if (!session) return; // reconciled on next connect

    if (!isRunDir(dir)) {
      console.warn(`[ssh] refusing to clean up unexpected run dir: ${dir}`);
      return;
    }
    await ops.removeRunDir(session, dir);
  }

  async readRunOutput(connectionId: string, dir: string): Promise<string> {
    return ops.readOutput(await this.session(connectionId), dir);
  }

  // Run dirs on the host that no active or unpersisted run owns.
  async listRuns(connectionId: string): Promise<RemoteRunInfo[]> {
    const infos  = await ops.listRunDirs(await this.session(connectionId));
    const active = new Set(this.activeRunDirs());
    return infos.filter((r) => !active.has(r.dir) && !this.unpersisted.has(r.dir));
  }

  // Stop an orphaned run (no active token) and delete its directory.
  async stopRun(connectionId: string, info: RemoteRunInfo): Promise<void> {
    const session = await this.session(connectionId);

    if (info.state === 'alive' && info.shell_pid) {
      if (info.shell_pid === session.shellPid) {
        throw new Error('run belongs to the active session shell; stop its token instead');
      }
      const remote: RemoteRun = {
        dir: info.dir, shell_pid: info.shell_pid, holder_pid: info.holder_pid ?? 0, started_at: info.started_at ?? '',
      };
      for (const sig of ['INT', 'TERM', 'KILL'] as Signal[]) {
        const extra = sig === 'KILL' ? [info.shell_pid, ...(info.holder_pid ? [info.holder_pid] : [])] : [];
        await ops.signalTree(session, info.shell_pid, sig, { interruptRoot: sig === 'INT', extra });
        await new Promise((r) => setTimeout(r, 1500));
        if ((await ops.inspectRun(session, remote)).state !== 'alive') break;
      }
    }

    await this.cleanupRun(connectionId, info.dir);
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  isConnected(connectionId: string): boolean {
    return this.sessions.has(connectionId);
  }

  connectedIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  activeRunDirs(): string[] {
    return Array.from(this.runs.values()).flatMap((r) => (r.remote ? [r.remote.dir] : []));
  }
}
