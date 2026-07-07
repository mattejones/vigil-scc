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

export interface Command {
  id:           string
  index:        number
  command:      string
  fatal:        boolean
  output?:      string
  stderr?:      string
  exit_code?:   number
  executed_at?: string
  completed_at?:string
}

export interface TokenError {
  reason:          string
  interrupted_at?: number
  human_note?:     string
  command?:        string
  stderr?:         string
  exit_code?:      number
}

export interface SessionMutation {
  id:        string
  command:   string
  output:    string
  stderr?:   string
  source:    'HUMAN'
  timestamp: string
}

export interface Token {
  id:                string
  description:       string
  status:            TokenStatus
  connection_id:     string
  source:            'AI' | 'HUMAN'
  commands:          Command[]
  error?:            TokenError
  session_mutations: SessionMutation[]
  created_at:        string
  updated_at:        string
  approved_at?:      string
  completed_at?:     string
}

export interface Connection {
  id:                string
  name:              string
  host:              string
  port:              number
  username:          string
  auth_type:         'key' | 'password'
  auto_approve:      boolean
  status:            'CONNECTED' | 'DISCONNECTED' | 'ERROR'
  error?:            string
  last_connected_at?:string
}
