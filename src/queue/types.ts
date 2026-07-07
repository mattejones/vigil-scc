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
  | 'SERVER_RESTART';

// ─── Command ─────────────────────────────────────────────────────────────────

export interface Command {
  id: string;
  index: number;       // position within the batch
  command: string;
  fatal: boolean;      // if false, batch continues on non-zero exit
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
  }>;
}

export interface CommandResult {
  output: string;
  stderr: string;
  exit_code: number;
}

// Injected into QueueManager — satisfied by the SSH registry later
export type CommandExecutor = (
  connection_id: string,
  command: string
) => Promise<CommandResult>;
