import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import type {
  Token,
  TokenStatus,
  TokenError,
  Command,
  SessionMutation,
  Connection,
  SessionEvent,
  TokenSource,
} from './types.js';

let db: Database.Database;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initDb(): void {
  const dbPath = process.env.DB_PATH ?? './data/vigil.db';
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id               TEXT PRIMARY KEY,
      description      TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
      connection_id    TEXT NOT NULL,
      source           TEXT NOT NULL DEFAULT 'AI',
      commands         TEXT NOT NULL DEFAULT '[]',
      error            TEXT,
      session_mutations TEXT NOT NULL DEFAULT '[]',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      approved_at      TEXT,
      completed_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS connections (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL UNIQUE,
      host              TEXT NOT NULL,
      port              INTEGER NOT NULL DEFAULT 22,
      username          TEXT NOT NULL,
      auth_type         TEXT NOT NULL DEFAULT 'key',
      private_key       TEXT,
      password          TEXT,
      auto_approve      INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'DISCONNECTED',
      error             TEXT,
      created_at        TEXT NOT NULL,
      last_connected_at TEXT
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id            TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      token_id      TEXT,
      command       TEXT NOT NULL,
      output        TEXT,
      stderr        TEXT,
      exit_code     INTEGER,
      source        TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_status        ON tokens(status);
    CREATE INDEX IF NOT EXISTS idx_tokens_connection    ON tokens(connection_id);
    CREATE INDEX IF NOT EXISTS idx_session_events_conn  ON session_events(connection_id);
  `);

  // Migrations — safe to run on every startup.
  try {
    db.exec(`ALTER TABLE connections ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }

  console.log(`[db] initialised → ${dbPath}`);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('[db] not initialised — call initDb() first');
  return db;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function rowToToken(row: Record<string, unknown>): Token {
  return {
    id:               row.id as string,
    description:      row.description as string,
    status:           row.status as TokenStatus,
    connection_id:    row.connection_id as string,
    source:           row.source as TokenSource,
    commands:         JSON.parse(row.commands as string),
    error:            row.error ? JSON.parse(row.error as string) : undefined,
    session_mutations: JSON.parse(row.session_mutations as string),
    created_at:       row.created_at as string,
    updated_at:       row.updated_at as string,
    approved_at:      row.approved_at as string | undefined,
    completed_at:     row.completed_at as string | undefined,
  };
}

// ─── Token CRUD ───────────────────────────────────────────────────────────────

export function createToken(
  params: Pick<Token, 'description' | 'connection_id' | 'source' | 'commands'>
): Token {
  const token: Token = {
    id:               uuidv4(),
    description:      params.description,
    status:           'PENDING_APPROVAL',
    connection_id:    params.connection_id,
    source:           params.source,
    commands:         params.commands,
    session_mutations: [],
    created_at:       now(),
    updated_at:       now(),
  };

  getDb().prepare(`
    INSERT INTO tokens
      (id, description, status, connection_id, source, commands, session_mutations, created_at, updated_at)
    VALUES
      (@id, @description, @status, @connection_id, @source, @commands, @session_mutations, @created_at, @updated_at)
  `).run({
    ...token,
    commands:          JSON.stringify(token.commands),
    session_mutations: JSON.stringify(token.session_mutations),
  });

  return token;
}

export function getToken(id: string): Token | undefined {
  const row = getDb().prepare('SELECT * FROM tokens WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? rowToToken(row) : undefined;
}

export function listTokens(statuses?: TokenStatus[]): Token[] {
  const rows = statuses?.length
    ? getDb()
        .prepare(`SELECT * FROM tokens WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC`)
        .all(...statuses) as Record<string, unknown>[]
    : getDb()
        .prepare('SELECT * FROM tokens ORDER BY created_at DESC')
        .all() as Record<string, unknown>[];

  return rows.map(rowToToken);
}

export function updateTokenStatus(
  id: string,
  status: TokenStatus,
  extra: { approved_at?: string; completed_at?: string } = {}
): void {
  getDb().prepare(`
    UPDATE tokens
    SET status = @status, updated_at = @updated_at
      ${extra.approved_at  ? ', approved_at  = @approved_at'  : ''}
      ${extra.completed_at ? ', completed_at = @completed_at' : ''}
    WHERE id = @id
  `).run({ id, status, updated_at: now(), ...extra });
}

export function updateTokenError(id: string, error: TokenError): void {
  getDb().prepare(`
    UPDATE tokens SET error = @error, updated_at = @updated_at WHERE id = @id
  `).run({ id, error: JSON.stringify(error), updated_at: now() });
}

export function updateCommand(
  tokenId: string,
  commandIndex: number,
  patch: Partial<Pick<Command, 'output' | 'stderr' | 'exit_code' | 'executed_at' | 'completed_at'>>
): void {
  const token = getToken(tokenId);
  if (!token) throw new Error(`[db] token ${tokenId} not found`);

  const commands = token.commands.map((cmd) =>
    cmd.index === commandIndex ? { ...cmd, ...patch } : cmd
  );

  getDb().prepare(`
    UPDATE tokens SET commands = @commands, updated_at = @updated_at WHERE id = @id
  `).run({ id: tokenId, commands: JSON.stringify(commands), updated_at: now() });
}

export function addSessionMutation(tokenId: string, mutation: SessionMutation): void {
  const token = getToken(tokenId);
  if (!token) throw new Error(`[db] token ${tokenId} not found`);

  const mutations = [...token.session_mutations, mutation];
  getDb().prepare(`
    UPDATE tokens SET session_mutations = @mutations, updated_at = @updated_at WHERE id = @id
  `).run({ id: tokenId, mutations: JSON.stringify(mutations), updated_at: now() });
}

// Mark any tokens that were RUNNING or APPROVED at shutdown as failed.
// Called on startup to prevent phantom in-progress tokens.
export function reconcileStaleTokens(): number {
  const result = getDb().prepare(`
    UPDATE tokens
    SET status = 'FAILED',
        error  = '{"reason":"SERVER_RESTART"}',
        updated_at = ?
    WHERE status IN ('RUNNING', 'APPROVED')
  `).run(now());

  return result.changes;
}

// ─── Connection CRUD ──────────────────────────────────────────────────────────

function rowToConnection(row: Record<string, unknown>): Connection {
  return {
    id:                row.id as string,
    name:              row.name as string,
    host:              row.host as string,
    port:              row.port as number,
    username:          row.username as string,
    auth_type:         row.auth_type as Connection['auth_type'],
    private_key:       row.private_key as string | undefined,
    password:          row.password as string | undefined,
    auto_approve:      Boolean(row.auto_approve),
    status:            row.status as Connection['status'],
    error:             row.error as string | undefined,
    created_at:        row.created_at as string,
    last_connected_at: row.last_connected_at as string | undefined,
  };
}

export function createConnection(
  params: Omit<Connection, 'id' | 'status' | 'created_at' | 'auto_approve'> & { auto_approve?: boolean }
): Connection {
  const conn: Connection = {
    id:           uuidv4(),
    status:       'DISCONNECTED',
    created_at:   now(),
    auto_approve: false,
    ...params,
  };

  const { auto_approve, ...rest } = conn;
  getDb().prepare(`
    INSERT INTO connections
      (id, name, host, port, username, auth_type, private_key, password, auto_approve, status, created_at)
    VALUES
      (@id, @name, @host, @port, @username, @auth_type, @private_key, @password, @auto_approve, @status, @created_at)
  `).run({ ...rest, auto_approve: auto_approve ? 1 : 0 });

  return conn;
}

export function getConnection(id: string): Connection | undefined {
  const row = getDb().prepare('SELECT * FROM connections WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? rowToConnection(row) : undefined;
}

export function listConnections(): Connection[] {
  const rows = getDb().prepare('SELECT * FROM connections ORDER BY name').all() as
    Record<string, unknown>[];
  return rows.map(rowToConnection);
}

export function updateConnection(
  id: string,
  patch: Partial<Pick<Connection, 'name' | 'host' | 'port' | 'username' | 'auth_type' | 'private_key' | 'password' | 'auto_approve'>>
): Connection {
  const conn = getConnection(id);
  if (!conn) throw new Error(`[db] connection ${id} not found`);

  const merged = { ...conn, ...patch };

  getDb().prepare(`
    UPDATE connections
    SET name=@name, host=@host, port=@port, username=@username,
        auth_type=@auth_type, private_key=@private_key, password=@password, auto_approve=@auto_approve
    WHERE id=@id
  `).run({
    id,
    name:         merged.name,
    host:         merged.host,
    port:         merged.port,
    username:     merged.username,
    auth_type:    merged.auth_type,
    private_key:  merged.private_key ?? null,
    password:     merged.password ?? null,
    auto_approve: merged.auto_approve ? 1 : 0,
  });

  return getConnection(id)!;
}

export function deleteConnection(id: string): void {
  getDb().prepare('DELETE FROM connections WHERE id = ?').run(id);
}

export function updateConnectionStatus(
  id: string,
  status: Connection['status'],
  extra: { error?: string; last_connected_at?: string } = {}
): void {
  getDb().prepare(`
    UPDATE connections
    SET status = @status
      ${extra.error             ? ', error = @error'                         : ', error = NULL'}
      ${extra.last_connected_at ? ', last_connected_at = @last_connected_at' : ''}
    WHERE id = @id
  `).run({ id, status, ...extra });
}

// ─── Session Events ───────────────────────────────────────────────────────────

export function logSessionEvent(event: Omit<SessionEvent, 'id' | 'created_at'>): SessionEvent {
  const full: SessionEvent = { id: uuidv4(), created_at: now(), ...event };

  getDb().prepare(`
    INSERT INTO session_events (id, connection_id, token_id, command, output, stderr, exit_code, source, created_at)
    VALUES (@id, @connection_id, @token_id, @command, @output, @stderr, @exit_code, @source, @created_at)
  `).run(full);

  return full;
}

export function getSessionEvents(connectionId: string, limit = 200): SessionEvent[] {
  return getDb().prepare(`
    SELECT * FROM session_events WHERE connection_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(connectionId, limit) as SessionEvent[];
}
