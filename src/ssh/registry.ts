import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import { EventEmitter } from 'events';
import {
  getConnection,
  updateConnectionStatus,
} from '../queue/store.js';
import type { CommandResult } from '../queue/types.js';

const CMD_TIMEOUT = parseInt(process.env.CMD_TIMEOUT_MS ?? '30000');
const DEBUG_SSH   = process.env.DEBUG_SSH === 'true';

function makeSentinel(): string {
  return `VIGIL_DONE_${Math.random().toString(36).slice(2)}`;
}

function dbg(connectionId: string, msg: string, data?: string): void {
  if (!DEBUG_SSH) return;
  console.log(`[ssh:debug][${connectionId}] ${msg}${data !== undefined ? ': ' + JSON.stringify(data) : ''}`);
}

interface ShellSession {
  client:  Client;
  stream:  ClientChannel;
  buffer:  string;
  busy:    boolean;
  pending?: {
    sentinel: string;
    resolve:  (result: CommandResult) => void;
    reject:   (err: Error) => void;
    timer:    ReturnType<typeof setTimeout>;
  };
}

export class SshRegistry extends EventEmitter {
  private sessions = new Map<string, ShellSession>();

  // ─── Connect ───────────────────────────────────────────────────────────────

  async connect(connectionId: string): Promise<void> {
    if (this.sessions.has(connectionId)) return;

    const conn = getConnection(connectionId);
    if (!conn) throw new Error(`[ssh] connection not found: ${connectionId}`);

    return new Promise((resolve, reject) => {
      const client = new Client();

      client.once('ready', () => {
        // false = no PTY allocation.
        // Without a PTY there is no terminal driver to echo input back,
        // which means our sentinel can only appear in the stream when we
        // deliberately write it — never as part of a command echo.
        client.shell(false, (err, stream) => {
          if (err) {
            client.end();
            return reject(err);
          }

          const session: ShellSession = { client, stream, buffer: '', busy: false };
          this.sessions.set(connectionId, session);

          stream.on('data', (chunk: Buffer) => {
            const data = chunk.toString('utf8');
            dbg(connectionId, 'raw', data);
            this.handleData(connectionId, data);
          });

          stream.on('close', () => this.handleClose(connectionId));

          // No stty needed (no PTY), just disable tracing and signal readiness.
          stream.write('set +xv; echo VIGIL_READY\n');

          updateConnectionStatus(connectionId, 'CONNECTED', {
            last_connected_at: new Date().toISOString(),
          });

          console.log(`[ssh] connected: ${conn.name} @ ${conn.host}:${conn.port}`);
          this.emit('connection:connected', connectionId);

          const readyTimer = setTimeout(() => {
            session.buffer = '';
            resolve();
          }, 1000);

          const readyCheck = setInterval(() => {
            if (session.buffer.includes('VIGIL_READY')) {
              clearTimeout(readyTimer);
              clearInterval(readyCheck);
              session.buffer = '';
              resolve();
            }
          }, 50);
        });
      });

      client.once('error', (err) => {
        updateConnectionStatus(connectionId, 'ERROR', { error: err.message });
        this.emit('connection:error', connectionId, err);
        reject(err);
      });

      const cfg: ConnectConfig = {
        host:     conn.host,
        port:     conn.port,
        username: conn.username,
        ...(conn.auth_type === 'key' && conn.private_key
          ? { privateKey: conn.private_key }
          : {}),
        ...(conn.auth_type === 'password' && conn.password
          ? { password: conn.password }
          : {}),
      };

      client.connect(cfg);
    });
  }

  // ─── Disconnect ────────────────────────────────────────────────────────────

  async disconnect(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (!session) return;

    if (session.pending) {
      clearTimeout(session.pending.timer);
      session.pending.reject(new Error('[ssh] disconnected by request'));
      delete session.pending;
    }

    session.stream.end();
    session.client.end();
    this.sessions.delete(connectionId);
    updateConnectionStatus(connectionId, 'DISCONNECTED');
    console.log(`[ssh] disconnected: ${connectionId}`);
  }

  // ─── Execute ───────────────────────────────────────────────────────────────

  async exec(connectionId: string, command: string): Promise<CommandResult> {
    if (!this.sessions.has(connectionId)) {
      await this.connect(connectionId);
    }

    const session = this.sessions.get(connectionId);
    if (!session) throw new Error(`[ssh] no session for: ${connectionId}`);
    if (session.busy) throw new Error(`[ssh] session is busy: ${connectionId}`);

    session.busy    = true;
    session.buffer  = '';
    const sentinel  = makeSentinel();

    dbg(connectionId, 'exec', command);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.pending) {
          delete session.pending;
          session.busy = false;
        }
        reject(new Error(`[ssh] command timed out after ${CMD_TIMEOUT}ms: ${command}`));
      }, CMD_TIMEOUT);

      session.pending = { sentinel, resolve, reject, timer };

      // Redirect stderr into stdout and write the sentinel on its own line
      // once the command group exits. The sentinel is unique per invocation
      // so it cannot appear in the output of the command itself.
      const wrapped = `{ ${command}; } 2>&1; echo "${sentinel}:$?"\n`;
      session.stream.write(wrapped);
    });
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  isConnected(connectionId: string): boolean {
    return this.sessions.has(connectionId);
  }

  connectedIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private handleData(connectionId: string, data: string): void {
    const session = this.sessions.get(connectionId);
    if (!session?.pending) return;

    session.buffer += data;

    const { sentinel } = session.pending;
    const sentinelIdx  = session.buffer.indexOf(sentinel);
    if (sentinelIdx === -1) return;

    const tail  = session.buffer.slice(sentinelIdx);
    const match = tail.match(new RegExp(`${sentinel}:(\\d+)`));
    if (!match) return;

    const exitCode = parseInt(match[1], 10);

    const raw    = session.buffer.slice(0, sentinelIdx);
    const output = stripAnsi(raw)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

    dbg(connectionId, 'output', output);
    dbg(connectionId, 'exit_code', String(exitCode));

    clearTimeout(session.pending.timer);
    const { resolve } = session.pending;
    delete session.pending;
    session.busy   = false;
    session.buffer = '';

    resolve({ output, stderr: '', exit_code: exitCode });
  }

  private handleClose(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;

    if (session.pending) {
      clearTimeout(session.pending.timer);
      session.pending.reject(new Error('[ssh] connection closed unexpectedly'));
      delete session.pending;
    }

    this.sessions.delete(connectionId);
    updateConnectionStatus(connectionId, 'DISCONNECTED');
    console.log(`[ssh] session closed: ${connectionId}`);
    this.emit('connection:disconnected', connectionId);
  }
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}
