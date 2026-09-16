// Shared types mirroring the server-side queue/types.ts
// Kept minimal — only what the UI needs.

export type TokenStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED'
  | 'WAITING_FOR_INPUT'

export type StopCause = 'HUMAN' | 'AI' | 'TIMEOUT'

export interface RemoteRun {
  dir:        string
  shell_pid:  number
  holder_pid: number
  started_at: string
}

export interface Command {
  id:               string
  index:            number
  command:          string
  fatal:            boolean
  timeout_seconds?: number
  remote_run?:      RemoteRun
  output?:          string
  stderr?:          string
  exit_code?:       number
  executed_at?:     string
  completed_at?:    string
}

export interface TokenError {
  reason:          string
  interrupted_at?: number
  human_note?:     string
  command?:        string
  stderr?:         string
  exit_code?:      number
  stopped_by?:     StopCause
  session_reset?:  boolean
  note?:           string
}

export interface SessionMutation {
  id:        string
  command:   string
  output:    string
  stderr?:   string
  source:    'HUMAN'
  timestamp: string
}

export interface InputRequest {
  id:            string
  command_index: number
  data:          string
  newline:       boolean
  eof:           boolean
  secret:        boolean
  source:        'AI' | 'HUMAN'
  status:        'PENDING' | 'SENT' | 'REJECTED' | 'EXPIRED' | 'FAILED'
  error?:        string
  created_at:    string
  resolved_at?:  string
}

export interface WaitingForInput {
  command_index: number
  prompt:        string
  recent_output: string
  since:         string
}

export interface Token {
  id:                 string
  description:        string
  status:             TokenStatus
  connection_id:      string
  source:             'AI' | 'HUMAN'
  commands:           Command[]
  error?:             TokenError
  session_mutations:  SessionMutation[]
  waiting_for_input?: WaitingForInput
  input_requests:     InputRequest[]
  recovered?:         boolean
  created_at:         string
  updated_at:         string
  approved_at?:       string
  completed_at?:      string
}

export interface Connection {
  id:                 string
  name:               string
  host:               string
  port:               number
  username:           string
  auth_type:          'key' | 'password'
  auto_approve:       boolean
  auto_approve_input: boolean
  status:             'CONNECTED' | 'DISCONNECTED' | 'ERROR'
  error?:             string
  last_connected_at?: string
}

export interface RemoteRunInfo {
  name:        string
  dir:         string
  state:       'alive' | 'exited' | 'dead'
  exit_code?:  number
  started_at?: string
  shell_pid?:  number
  holder_pid?: number
}

export interface InputPayload {
  data:    string
  newline: boolean
  eof:     boolean
  secret:  boolean
}
