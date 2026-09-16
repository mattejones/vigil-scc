import express from 'express';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDb } from './queue/store.js';
import { queue } from './queue/queue.js';
import { initSsh } from './ssh/index.js';
import { mcpRouter } from './mcp/router.js';
import { apiRouter } from './api/router.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT     = parseInt(process.env.PORT     ?? '3000');
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '3001');

// ─── Bootstrap ────────────────────────────────────────────────────────────────

initDb();
initSsh();
queue.init();   // after initSsh: reattaches to runs that were in flight at shutdown

// ─── Web UI server (port 3000) ────────────────────────────────────────────────

const app = express();
const httpServer = createHttpServer(app);

export const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' },
});

app.use(cors());
app.use(express.json());

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'vigil-scc', version: '0.1.0' });
});

app.use('/api', apiRouter);

io.on('connection', (socket) => {
  console.log(`[ws] client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[ws] client disconnected: ${socket.id}`);
  });
});

// ─── Queue → WebSocket bridge ─────────────────────────────────────────────────

const bridgedEvents = [
  'token:created',
  'token:approved',
  'token:rejected',
  'token:started',
  'token:command:output',
  'token:command:complete',
  'token:completed',
  'token:failed',
  'token:waiting',
  'token:running',
  'token:input:requested',
  'token:input:resolved',
  'token:recovered',
  'connection:connected',
  'connection:disconnected',
  'connection:error',
  'connection:created',
  'connection:updated',
  'connection:deleted',
] as const;

for (const event of bridgedEvents) {
  queue.on(event, (payload) => {
    io.emit(event, payload);
  });
}

// ─── MCP server (port 3001) ───────────────────────────────────────────────────

const mcpApp = express();
mcpApp.use(cors());
mcpApp.use(express.json());
mcpApp.use('/mcp', mcpRouter);

mcpApp.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'vigil-scc-mcp', version: '0.1.0' });
});

function createMcpServer() {
  const keyPath  = process.env.SSL_KEY_PATH;
  const certPath = process.env.SSL_CERT_PATH;

  if (keyPath && certPath) {
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      console.warn('[mcp] SSL cert files not found — falling back to HTTP');
      return { server: createHttpServer(mcpApp), protocol: 'http' };
    }
    const tls = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    return { server: createHttpsServer(tls, mcpApp), protocol: 'https' };
  }

  return { server: createHttpServer(mcpApp), protocol: 'http' };
}

const { server: mcpServer, protocol: mcpProtocol } = createMcpServer();

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[web] listening on http://localhost:${PORT}`);
});

mcpServer.listen(MCP_PORT, () => {
  console.log(`[mcp] listening on ${mcpProtocol}://localhost:${MCP_PORT}/mcp`);
});

console.log(`
  ██╗   ██╗██╗ ██████╗ ██╗██╗     
  ██║   ██║██║██╔════╝ ██║██║     
  ██║   ██║██║██║  ███╗██║██║     
  ╚██╗ ██╔╝██║██║   ██║██║██║     
   ╚████╔╝ ██║╚██████╔╝██║███████╗
    ╚═══╝  ╚═╝ ╚═════╝ ╚═╝╚══════╝
  SSH Command Center v0.1.0
  ─────────────────────────────────
  Web UI → http://localhost:${PORT}
  MCP    → ${mcpProtocol}://localhost:${MCP_PORT}/mcp
`);
