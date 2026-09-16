import type { ClientChannel } from 'ssh2';
import { config } from '../config.js';
import { RunDetachedError } from '../queue/types.js';
import type { ExecOptions, ExecResult, RemoteRun, StopCause } from '../queue/types.js';
import { OutputBuffer, stripAnsi } from './output-buffer.js';
import * as ops from './remote-ops.js';
import type { Signal } from './remote-ops.js';
import * as protocol from './shell-protocol.js';
import { dbg } from './shell-session.js';
import type { ShellSession } from './shell-session.js';

// tracked:   output goes to a run dir, tailed over a side channel
// untracked: run dir unavailable, output comes back over the shell channel
// recovered: reattached to a run whose original shell we no longer own
export type RunMode  = 'tracked' | 'untracked' | 'recovered';
type RunPhase        = 'starting' | 'running' | 'finishing' | 'done';

export interface RunHooks {
  // Called synchronously when the run settles, before `result` resolves or rejects.
  onSettled(run: CommandRun, outcome: { result?: ExecResult; error?: Error }): void;
  // The command survived SIGKILL; the owner should reset the session.
  onUnstoppable(run: CommandRun): void;
}

const PROBE_REPEAT_MS = 15000;

// One command executing on (or reattached through) a shell session: drives the
// wrapper protocol, follows output, detects stdin prompts, and stops the
// process tree on request.
export class CommandRun {
  readonly result: Promise<ExecResult>;
  mode:    RunMode;
  remote?: RemoteRun;

  private phase: RunPhase = 'starting';
  private readonly sentinel = protocol.makeSentinel();
  private shellBuf = '';
  private readonly output = new OutputBuffer(config.outputMaxBytes);
  private tail?: ClientChannel;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private lastOutputAt = Date.now();
  private lastProbeAt  = 0;
  private probing  = false;
  private waiting  = false;
  private stopping = false;
  private stopCause?: StopCause;
  private readonly done: Promise<void>;
  private markDone!: () => void;
  private resolve!:  (result: ExecResult) => void;
  private reject!:   (err: Error) => void;

  private constructor(
    readonly session: ShellSession,
    private readonly command: string,
    private readonly opts: ExecOptions,
    private readonly hooks: RunHooks,
    mode: RunMode,
  ) {
    this.mode   = mode;
    this.done   = new Promise((r) => { this.markDone = r; });
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject  = reject;
    });
  }

  // Launch a command in the session's shell. The command itself is written once
  // the shell has reported its run dir (see handleShellData).
  static start(session: ShellSession, command: string, opts: ExecOptions, hooks: RunHooks): CommandRun {
    const run = new CommandRun(session, command, opts, hooks, 'tracked');
    dbg(session.connectionId, 'exec', command);
    session.write(protocol.prepareRunLine(opts.name, run.sentinel));
    run.armTimers(true);
    return run;
  }

  // Follow a run that outlived its original shell. `logSize` is the current size of its `out`.
  static reattach(session: ShellSession, remote: RemoteRun, logSize: number, opts: ExecOptions, hooks: RunHooks): CommandRun {
    const run  = new CommandRun(session, '', opts, hooks, 'recovered');
    run.remote = remote;
    run.phase  = 'running';

    const skipped = Math.max(0, logSize - config.outputMaxBytes);
    run.output.startAt(skipped);
    run.startTail(skipped + 1);
    run.armTimers(false);
    return run;
  }

  get connectionId(): string {
    return this.session.connectionId;
  }

  get isSettled(): boolean {
    return this.phase === 'done';
  }

  // ─── Shell channel ─────────────────────────────────────────────────────────

  handleShellData(text: string): void {
    if (this.mode === 'recovered' || this.phase === 'done') return;
    this.shellBuf += text;

    if (this.phase === 'starting') {
      const start = protocol.parseRunStart(this.shellBuf, this.sentinel);
      if (!start) return;

      this.shellBuf = start.rest;
      this.phase    = 'running';

      if (start.tracked) {
        this.remote = start.remote;
        this.opts.onRunStarted?.(start.remote);
        this.startTail(1);
        this.session.write(protocol.trackedCommandLine(this.command, this.sentinel));
      } else {
        console.warn(`[ssh] could not create a run directory on ${this.connectionId}; running untracked (no input, no recovery)`);
        this.mode = 'untracked';
        this.session.write(protocol.untrackedCommandLine(this.command, this.sentinel));
      }
    }

    if (this.phase !== 'running') return;

    const end = protocol.parseRunEnd(this.shellBuf, this.sentinel);

    if (this.mode === 'untracked') {
      if (end) {
        this.appendText(this.shellBuf.slice(0, end.index));
        this.shellBuf = '';
        this.finish(this.resultWith(end.exitCode));
      } else {
        const keep = protocol.sentinelHoldback(this.sentinel);
        if (this.shellBuf.length > keep) {
          this.appendText(this.shellBuf.slice(0, -keep));
          this.shellBuf = this.shellBuf.slice(-keep);
        }
      }
      return;
    }

    if (end) {
      this.shellBuf = '';
      void this.completeTracked(end.exitCode);
    }
  }

  // The session went away while this run was active.
  sessionClosed(reason: string, opts: { detach?: boolean }): void {
    if (this.isSettled) return;

    if (this.stopCause) {
      this.finish({ ...this.resultWith(-1), session_reset: true });
    } else if (this.remote && opts.detach !== false) {
      this.fail(new RunDetachedError(this.remote, `[ssh] connection lost while command was running (${reason})`));
    } else {
      this.fail(new Error(
        `[ssh] ${reason}` + (this.remote ? ` — the command may still be running on the host in ${this.remote.dir}` : ''),
      ));
    }
  }

  // ─── Completion ────────────────────────────────────────────────────────────

  private async completeTracked(exitCode: number): Promise<void> {
    if (this.phase !== 'running') return;
    this.phase = 'finishing';
    this.detachTail();

    try {
      await this.catchUpOutput();
    } catch (err) {
      console.warn(`[ssh] could not read final output for ${this.remote?.dir}: ${(err as Error).message}`);
    }
    this.finish(this.resultWith(exitCode));
  }

  // A reattached run's tail ended: find out why.
  private async completeRecovered(): Promise<void> {
    if (this.phase !== 'running' || !this.remote) return;
    this.phase = 'finishing';

    try {
      const info = await ops.inspectRun(this.session, this.remote);
      await this.catchUpOutput();

      if (info.state === 'exited') {
        this.finish(this.resultWith(info.exit_code ?? -1));
      } else if (info.state === 'alive') {
        // Tail ended early (e.g. its channel dropped) — resume following.
        this.phase = 'running';
        this.startTail(this.output.bytes + 1);
      } else {
        this.finish({ ...this.resultWith(-1), lost: true, note: 'the command stopped without recording an exit code' });
      }
    } catch (err) {
      if (this.isSettled) return;
      if (!this.session.isOpen) return; // sessionClosed will detach it
      this.finish({ ...this.resultWith(-1), lost: true, note: (err as Error).message });
    }
  }

  private resultWith(exitCode: number): ExecResult {
    return {
      output:     this.output.final(),
      stderr:     '',
      exit_code:  exitCode,
      stopped_by: this.stopCause,
    };
  }

  private finish(result: ExecResult): void {
    if (this.isSettled) return;
    const outcome = { ...result, run: this.remote };
    this.settle({ result: outcome });
    this.resolve(outcome);
  }

  private fail(error: Error): void {
    if (this.isSettled) return;
    this.settle({ error });
    this.reject(error);
  }

  private settle(outcome: { result?: ExecResult; error?: Error }): void {
    this.phase = 'done';
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    this.detachTail();
    this.hooks.onSettled(this, outcome);
    this.markDone();
  }

  // ─── Stop ──────────────────────────────────────────────────────────────────

  stop(cause: StopCause): void {
    void this.escalate(cause);
  }

  // SIGINT → SIGTERM → SIGKILL on the command's process tree. The shell gets a
  // single SIGINT, which its run trap turns into `return 130` once the
  // foreground child is gone — aborting loops and builtins that run in the shell
  // itself. The shell is never killed; if the command survives SIGKILL the
  // owner resets the session instead.
  private async escalate(cause: StopCause): Promise<void> {
    if (this.stopping || this.isSettled) return;
    this.stopping  = true;
    this.stopCause = this.stopCause ?? cause;

    const grace = config.interruptGraceMs;
    console.log(`[ssh] stopping command on ${this.connectionId} (cause: ${cause})`);

    if (this.phase === 'starting') {
      const deadline = Date.now() + grace;
      while (this.phase === 'starting' && Date.now() < deadline) await sleep(50);
    }

    const signals: Signal[] = ['INT', 'TERM', 'KILL'];
    for (const sig of signals) {
      if (this.isSettled) return;

      const root = this.remote?.shell_pid ?? this.session.shellPid;
      const extra: number[] = [];
      if (sig === 'KILL' && this.remote)              extra.push(this.remote.holder_pid);
      if (sig === 'KILL' && this.mode === 'recovered') extra.push(root); // orphaned shell, safe to kill

      try {
        await ops.signalTree(this.session, root, sig, { interruptRoot: sig === 'INT', extra });
      } catch (err) {
        console.warn(`[ssh] failed to send SIG${sig} on ${this.connectionId}: ${(err as Error).message}`);
      }

      if (await this.waitDone(grace)) return;
    }

    if (this.isSettled) return;

    if (this.mode === 'recovered') {
      this.finish({ ...this.resultWith(-1), lost: true, note: 'command did not exit after SIGKILL' });
    } else {
      this.hooks.onUnstoppable(this);
    }
  }

  private waitDone(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.phase === 'done'), ms);
      void this.done.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  private armTimers(allowTimeout: boolean): void {
    const timeoutMs = this.opts.timeoutMs && this.opts.timeoutMs > 0 ? this.opts.timeoutMs : config.cmdTimeoutMs;

    if (allowTimeout && timeoutMs > 0) {
      this.timers.push(setTimeout(() => {
        console.warn(`[ssh] command timed out after ${timeoutMs}ms on ${this.connectionId}`);
        void this.escalate('TIMEOUT');
      }, timeoutMs));
    }

    if (this.opts.onWaiting) {
      this.timers.push(setInterval(() => this.checkIdle(), 1000));
    }
  }

  // ─── Input ─────────────────────────────────────────────────────────────────

  async sendInput(data: string, eof: boolean): Promise<void> {
    if (this.phase !== 'running') throw new Error('no running command to send input to');
    if (!this.remote) throw new Error('this command is running without a run directory; input is not supported');

    if (data) await ops.writeStdin(this.session, this.remote, data);
    if (eof)  await ops.closeStdin(this.session, this.remote);

    this.lastOutputAt = Date.now();
    this.setWaiting(false);
  }

  // Poll (while idle) whether the command is blocked reading stdin.
  private checkIdle(): void {
    if (this.phase !== 'running' || !this.remote || this.probing || this.waiting || this.stopping) return;

    const idleMs = config.inputIdleMs;
    const now    = Date.now();
    if (now - this.lastOutputAt < idleMs) return;
    if (this.lastProbeAt > this.lastOutputAt && now - this.lastProbeAt < PROBE_REPEAT_MS) return;

    this.probing     = true;
    this.lastProbeAt = now;

    ops.probeStdin(this.session, this.remote)
      .then((state) => {
        if (this.phase !== 'running' || this.waiting) return;
        if (Date.now() - this.lastOutputAt < idleMs) return; // output arrived meanwhile

        // Fallback when /proc can't tell us: a trailing partial line looks like a prompt.
        if (state === 'WAITING' || (state === 'UNKNOWN' && this.output.endsMidLine)) {
          this.setWaiting(true);
        }
      })
      .catch((err: Error) => dbg(this.connectionId, 'input probe failed', err.message))
      .finally(() => { this.probing = false; });
  }

  private setWaiting(waiting: boolean): void {
    if (this.waiting === waiting) return;
    this.waiting = waiting;
    this.opts.onWaiting?.(waiting ? this.output.waitingInfo() : null);
  }

  // ─── Output ────────────────────────────────────────────────────────────────

  private startTail(fromByte: number): void {
    const remote = this.remote!;

    ops.tailOutput(this.session, remote, fromByte).then((ch) => {
      if (this.phase !== 'running') { ch.close(); return; }
      this.tail = ch;

      ch.on('data', (chunk: Buffer) => {
        if (this.tail === ch) this.outputAdded(this.output.pushBytes(chunk));
      });

      ch.on('close', () => {
        if (this.tail !== ch) return;
        this.tail = undefined;
        if (this.mode === 'recovered') void this.completeRecovered();
      });
    }).catch((err: Error) => {
      console.warn(`[ssh] could not tail output for ${remote.dir}: ${err.message}`);
      if (this.mode === 'recovered' && this.phase === 'running') {
        setTimeout(() => void this.completeRecovered(), 2000);
      }
    });
  }

  private detachTail(): void {
    const ch = this.tail;
    this.tail = undefined;
    if (ch) {
      try { ch.close(); } catch { /* already closed */ }
    }
  }

  // Read whatever the tail hadn't delivered yet, straight from the file.
  private async catchUpOutput(): Promise<void> {
    if (!this.remote) return;
    const rest = await ops.readOutputFrom(this.session, this.remote.dir, this.output.bytes + 1);
    this.outputAdded(this.output.pushBytes(rest, true));
  }

  private appendText(text: string): void {
    this.output.pushText(text);
    this.outputAdded(text);
  }

  private outputAdded(text: string): void {
    if (!text) return;
    this.lastOutputAt = Date.now();
    this.setWaiting(false);
    this.opts.onOutput?.(stripAnsi(text).replace(/\r\n/g, '\n'));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
