// ─── Token Status ────────────────────────────────────────────────────────────

export type TokenStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED'
  | 'WAITING_FOR_INPUT';

export type TokenSource = 'AI' | 'HUMAN';

export type ErrorReason =
  | 'REJECTED'
  | 'EXEC_FAILURE'
  | 'TIMEOUT'
  | 'CONNECTION_ERROR'
  | 'SERVER_RESTART'
  | 'STOPPED'
  | 'SESSION_LOST';

// Who or what stopped a running command.
export type StopCause = 'HUMAN' | 'AI' | 'TIMEOUT';

// ─── Remote Run ──────────────────────────────────────────────────────────────
// Every tracked command runs out of a directory on the remote host holding its
// stdin FIFO, output log, exit code and pids. Persisted on the command so a
// restarted Vigil can reattach to (or clean up) the run.

export interface RemoteRun {
  dir:        string;   // absolute path on the remote host
  shell_pid:  number;   // pid of the shell the command runs under
  holder_pid: number;   // pid keeping the stdin FIFO's write end open
  started_at: string;
}

// ─── Command ─────────────────────────────────────────────────────────────────

export interface Command {
  id: string;
  index: number;       // position within the batch
  command: string;
  fatal: boolean;      // if false, batch continues on non-zero exit
  timeout_seconds?: number;  // optional per-command timeout (stop on expiry)
  remote_run?: RemoteRun;
  output?: string;
  stderr?: string;
  exit_code?: number;
  executed_at?: string;
  completed_at?: string;
}

// ─── Error ───────────────────────────────────────────────────────────────────

export interface TokenError {
  reason: ErrorReason;
  interrupted_at?: number;  // command index that caused failure
  human_note?: string;      // rejection note from operator
  command?: string;         // the offending command string
  stderr?: string;
  exit_code?: number;
  stopped_by?: StopCause;
  session_reset?: boolean;  // the SSH session had to be torn down to stop the command
  note?: string;
}

// ─── Input ───────────────────────────────────────────────────────────────────
// Stdin sent to a running command. AI requests need operator approval unless
// the connection auto-approves input.

export type InputRequestStatus = 'PENDING' | 'SENT' | 'REJECTED' | 'EXPIRED' | 'FAILED';

export interface InputRequest {
  id:            string;
  command_index: number;
  data:          string;     // '[redacted]' when secret
  newline:       boolean;
  eof:           boolean;
  secret:        boolean;
  source:        TokenSource;
  status:        InputRequestStatus;
  error?:        string;
  created_at:    string;
  resolved_at?:  string;
}

export interface WaitingForInput {
  command_index: number;
  prompt:        string;
  recent_output: string;
  since:         string;
}

// ─── Session Mutations ───────────────────────────────────────────────────────
// Commands injected directly by the human operator during a token's execution.
// Surfaced back to the AI when it polls so it can reconcile its world model.

export interface SessionMutation {
  id: string;
  command: string;
  output: string;
  stderr?: string;
  source: 'HUMAN';
  timestamp: string;
}

// ─── Token ───────────────────────────────────────────────────────────────────

export interface Token {
  id: string;
  description: string;
  status: TokenStatus;
  connection_id: string;
  source: TokenSource;
  commands: Command[];
  error?: TokenError;
  session_mutations: SessionMutation[];
  waiting_for_input?: WaitingForInput;
  input_requests: InputRequest[];
  recovered?: boolean;       // reattached to a run after a restart or dropped connection
  created_at: string;
  updated_at: string;
  approved_at?: string;
  completed_at?: string;
}

// ─── Connection ──────────────────────────────────────────────────────────────

export type ConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
export type AuthType = 'key' | 'password';

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  private_key?: string;   // PEM content
  password?: string;
  auto_approve: boolean;
  auto_approve_input: boolean;
  status: ConnectionStatus;
  error?: string;
  created_at: string;
  last_connected_at?: string;
}

// ─── Session Event ───────────────────────────────────────────────────────────
// Append-only audit log of every command that touched a session.

export interface SessionEvent {
  id: string;
  connection_id: string;
  token_id?: string;      // null for human-injected commands
  command: string;
  output?: string;
  stderr?: string;
  exit_code?: number;
  source: TokenSource;
  created_at: string;
}

// ─── Request / Response shapes ───────────────────────────────────────────────

export interface EnqueueRequest {
  connection_id: string;
  description: string;
  commands: Array<{
    command: string;
    fatal?: boolean;  // defaults to true
    timeout_seconds?: number;
  }>;
}

export interface CommandResult {
  output: string;
  stderr: string;
  exit_code: number;
}

export interface ExecOptions {
  name:          string;   // run directory name, e.g. `<token_id>-<index>`
  timeoutMs?:    number;   // 0/undefined → CMD_TIMEOUT_MS fallback (0 = none)
  onOutput?:     (chunk: string) => void;
  onWaiting?:    (info: { prompt: string; recent_output: string } | null) => void;
  onRunStarted?: (run: RemoteRun) => void;
  isAborted?:    () => StopCause | undefined;
}

export interface ExecResult extends CommandResult {
  stopped_by?:    StopCause;
  session_reset?: boolean;
  lost?:          boolean;  // run vanished (no exit code recoverable)
  note?:          string;
  run?:           RemoteRun;
}

export interface RemoteRunInfo {
  name:       string;
  dir:        string;
  state:      'alive' | 'exited' | 'dead';
  exit_code?: number;
  started_at?: string;
  shell_pid?: number;
  holder_pid?: number;
}

// Thrown when the SSH connection drops while a tracked run is still going.
// The run keeps executing on the host and can be reattached.
export class RunDetachedError extends Error {
  constructor(public run: RemoteRun, message: string) {
    super(message);
    this.name = 'RunDetachedError';
  }
}

// Injected into QueueManager — satisfied by the SSH registry.
export interface CommandRunner {
  ensureConnected(connectionId: string): Promise<void>;
  exec(connectionId: string, command: string, opts: ExecOptions): Promise<ExecResult>;
  recover(connectionId: string, run: RemoteRun, opts: ExecOptions): Promise<ExecResult>;
  stop(connectionId: string, cause: StopCause): Promise<boolean>;
  sendInput(connectionId: string, data: string, eof: boolean): Promise<void>;
  cleanupRun(connectionId: string, dir: string): Promise<void>;
  readRunOutput(connectionId: string, dir: string): Promise<string>;
  listRuns(connectionId: string): Promise<RemoteRunInfo[]>;
  stopRun(connectionId: string, info: RemoteRunInfo): Promise<void>;
}
