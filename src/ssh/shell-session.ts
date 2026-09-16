import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { config } from '../config.js';
import type { Connection } from '../queue/types.js';
import { HANDSHAKE_LINE, parseHandshake, sq } from './shell-protocol.js';

export function dbg(connectionId: string, msg: string, data?: string): void {
  if (!config.debugSsh) return;
  console.log(`[ssh:debug][${connectionId}] ${msg}${data !== undefined ? ': ' + JSON.stringify(data) : ''}`);
}

export interface SideExecResult {
  stdout:  Buffer;
  stderr:  string;
  code:    number | null;   // null when killed by a signal or no status was reported
  signal?: string;
}

export interface CloseOptions {
  error?:  boolean;  // closed because of a client error (status already ERROR)
  detach?: boolean;  // false: a running command should not be reattached
}

// One SSH connection with its persistent shell, plus side exec channels for
// helper scripts.
//
// Events:
//   'data'        (text: string)                         shell output
//   'clientError' (err: Error)                            ssh2 error after setup
//   'close'       (reason: string, opts: CloseOptions)    emitted once
export class ShellSession extends EventEmitter {
  shellPid = 0;
  private closed = false;

  private constructor(
    readonly connectionId: string,
    readonly client: Client,
    private readonly stream: ClientChannel,
  ) {
    super();
  }

  // Connect, open a no-PTY shell and wait for its handshake.
  static open(conn: Connection): Promise<ShellSession> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let session: ShellSession | undefined;
      let settled = false;
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

      const failSetup = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        client.end();
        reject(err);
      };

      // Persistent listeners: ssh2 can emit 'error' more than once over a
      // connection's life, and an unhandled 'error' crashes the process.
      client.on('error', (err) => {
        console.error(`[ssh] client error (${conn.name}): ${err.message}`);
        if (!settled || !session) return failSetup(err);
        session.emit('clientError', err);
        session.close(`error: ${err.message}`, { error: true });
      });

      client.on('close', () => {
        if (!settled || !session) return failSetup(new Error('[ssh] connection closed during setup'));
        session.close('connection closed');
      });

      client.once('ready', () => {
        // false = no PTY allocation.
        // Without a PTY there is no terminal driver to echo input back,
        // which means our sentinel can only appear in the stream when we
        // deliberately write it — never as part of a command echo.
        client.shell(false, (err, stream) => {
          if (err) return failSetup(err);

          const created = new ShellSession(conn.id, client, stream);
          session = created;
          const decoder = new StringDecoder('utf8');
          let handshake = '';

          stream.on('error', (e: Error) => {
            if (!settled) failSetup(e);
            else created.close(`shell error: ${e.message}`);
          });

          stream.on('close', () => {
            if (!settled) failSetup(new Error('[ssh] shell closed during setup'));
            else created.close('shell closed');
          });

          stream.on('data', (chunk: Buffer) => {
            const data = decoder.write(chunk);
            dbg(conn.id, 'raw', data);

            if (settled) {
              created.emit('data', data);
              return;
            }

            handshake += data;
            const shellPid = parseHandshake(handshake);
            if (shellPid === null) return;

            settled = true;
            clearTimeout(handshakeTimer);
            created.shellPid = shellPid;
            resolve(created);
          });

          const readyMs = config.sshReadyTimeoutMs;
          handshakeTimer = setTimeout(
            () => failSetup(new Error(`[ssh] shell did not become ready within ${readyMs}ms`)),
            readyMs,
          );

          stream.write(HANDSHAKE_LINE);
        });
      });

      const cfg: ConnectConfig = {
        host:              conn.host,
        port:              conn.port,
        username:          conn.username,
        keepaliveInterval: config.sshKeepaliveMs,
        keepaliveCountMax: config.sshKeepaliveCountMax,
        readyTimeout:      config.sshReadyTimeoutMs,
        ...(conn.auth_type === 'key' && conn.private_key
          ? { privateKey: conn.private_key }
          : {}),
        ...(conn.auth_type === 'password' && conn.password
          ? { password: conn.password }
          : {}),
      };

      try {
        client.connect(cfg);
      } catch (err) {
        failSetup(err as Error);
      }
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  write(text: string): void {
    if (!this.closed) this.stream.write(text);
  }

  // Idempotent.
  close(reason: string, opts: CloseOptions = {}): void {
    if (this.closed) return;
    this.closed = true;
    try { this.stream.destroy(); } catch { /* already closed */ }
    try { this.client.end(); } catch { /* already closed */ }
    this.emit('close', reason, opts);
  }

  // Run a helper script on a separate channel and collect its output.
  exec(script: string, opts: { stdin?: string; timeoutMs?: number } = {}): Promise<SideExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(`sh -c ${sq(script)}`, (err, ch) => {
        if (err) return reject(err);

        const out: Buffer[] = [];
        let stderr = '';
        let code: number | null = null;
        let signal: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;

        if (opts.timeoutMs) {
          timer = setTimeout(() => {
            try { ch.close(); } catch { /* ignore */ }
            reject(new Error(`[ssh] remote helper timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs);
        }

        ch.on('data', (b: Buffer) => out.push(b));
        ch.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
        ch.on('exit', (c: number | null, sig?: string) => {
          code   = typeof c === 'number' ? c : null;
          signal = sig;
        });
        ch.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
        ch.on('close', () => {
          clearTimeout(timer);
          resolve({ stdout: Buffer.concat(out), stderr, code, signal });
        });

        if (opts.stdin !== undefined) ch.end(opts.stdin);
        else ch.end();
      });
    });
  }

  // Start a long-lived helper script and hand back its channel.
  openChannel(script: string): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client.exec(`sh -c ${sq(script)}`, (err, ch) => {
        if (err) return reject(err);
        ch.on('error', () => { /* surfaced via 'close' */ });
        ch.stderr.resume();
        resolve(ch);
      });
    });
  }
}
