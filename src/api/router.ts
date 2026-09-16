import { Router } from 'express';
import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import { queue } from '../queue/queue.js';
import {
  listTokens,
  getToken,
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
} from '../queue/store.js';
import { sshRegistry } from '../ssh/index.js';

const router = Router();

// ─── Tokens ───────────────────────────────────────────────────────────────────

router.get('/tokens', (req, res) => {
  const status = req.query.status as string | undefined;
  const statuses = status ? [status] : undefined;
  res.json(listTokens(statuses as any));
});

router.get('/tokens/:id', (req, res) => {
  const token = getToken(req.params.id);
  if (!token) return res.status(404).json({ error: 'Token not found' });
  res.json(token);
});

router.post('/tokens/:id/approve', (req, res) => {
  try {
    queue.approve(req.params.id);
    res.json({ ok: true, token_id: req.params.id });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

router.post('/tokens/:id/reject', (req, res) => {
  try {
    const { note } = req.body as { note?: string };
    queue.reject(req.params.id, note);
    res.json({ ok: true, token_id: req.params.id });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// Stop a running command (SIGINT → SIGTERM → SIGKILL).
router.post('/tokens/:id/stop', async (req, res) => {
  try {
    await queue.stop(req.params.id, 'HUMAN');
    res.json({ ok: true, token_id: req.params.id });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// Operator input goes straight to the running command.
router.post('/tokens/:id/input', async (req, res) => {
  try {
    const { data = '', newline = true, eof = false, secret = false } = (req.body ?? {}) as Record<string, any>;
    const request = await queue.sendInput(req.params.id, {
      data: String(data), newline: Boolean(newline), eof: Boolean(eof), secret: Boolean(secret),
    }, 'HUMAN');
    if (request.status !== 'SENT') return res.status(400).json({ error: request.error ?? request.status, request });
    res.json({ ok: true, request });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

router.post('/tokens/:id/input/:requestId/approve', async (req, res) => {
  try {
    const request = await queue.approveInput(req.params.id, req.params.requestId);
    if (request.status !== 'SENT') return res.status(400).json({ error: request.error ?? request.status, request });
    res.json({ ok: true, request });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

router.post('/tokens/:id/input/:requestId/reject', (req, res) => {
  try {
    const request = queue.rejectInput(req.params.id, req.params.requestId);
    res.json({ ok: true, request });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// ─── Connections ──────────────────────────────────────────────────────────────

function sanitize(conn: ReturnType<typeof getConnection>) {
  if (!conn) return conn;
  const { private_key: _pk, password: _pw, ...safe } = conn;
  return safe;
}

router.get('/connections', (_req, res) => {
  res.json(listConnections().map(c => sanitize(c)));
});

router.post('/connections', (req, res) => {
  try {
    const { name, host, port = 22, username, auth_type, private_key, password, auto_approve = false, auto_approve_input = false } = req.body as Record<string, any>;
    if (!name || !host || !username || !auth_type) {
      return res.status(400).json({ error: 'Missing required fields: name, host, username, auth_type' });
    }
    const conn = createConnection({ name, host, port: Number(port), username, auth_type, private_key, password, auto_approve: Boolean(auto_approve), auto_approve_input: Boolean(auto_approve_input) });
    queue.emit('connection:created', sanitize(conn));
    res.status(201).json(sanitize(conn));
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// Static route must come before /:id routes
router.post('/connections/test', async (req, res) => {
  const { host, port = 22, username, auth_type, private_key, password } = req.body as Record<string, any>;
  if (!host || !username || !auth_type) {
    return res.status(400).json({ error: 'Missing required fields: host, username, auth_type' });
  }
  try {
    await testSshParams({ host, port: Number(port), username, auth_type, private_key, password });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: String(err).replace(/^Error:\s*/, '') });
  }
});

router.put('/connections/:id', async (req, res) => {
  try {
    const conn = getConnection(req.params.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const { name, host, port, username, auth_type, private_key, password, auto_approve, auto_approve_input } = req.body as Record<string, any>;

    // Only credential/target changes need a fresh session — toggles don't.
    const needsReconnect = [host, port, username, auth_type, private_key, password].some((v) => v !== undefined && v !== '');
    if (needsReconnect && sshRegistry.isConnected(req.params.id)) {
      await sshRegistry.disconnect(req.params.id);
    }

    const patch: Parameters<typeof updateConnection>[1] = {};
    if (name        !== undefined) patch.name        = name;
    if (host        !== undefined) patch.host        = host;
    if (port        !== undefined) patch.port        = Number(port);
    if (username    !== undefined) patch.username    = username;
    if (auth_type   !== undefined) patch.auth_type   = auth_type;
    if (auto_approve !== undefined) patch.auto_approve = Boolean(auto_approve);
    if (auto_approve_input !== undefined) patch.auto_approve_input = Boolean(auto_approve_input);
    if (private_key)               patch.private_key  = private_key;
    if (password)                  patch.password     = password;

    const updated = updateConnection(req.params.id, patch);
    queue.emit('connection:updated', sanitize(updated));
    res.json(sanitize(updated));
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

router.delete('/connections/:id', (req, res) => {
  try {
    const conn = getConnection(req.params.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    if (sshRegistry.isConnected(req.params.id)) {
      return res.status(400).json({ error: 'Cannot delete an active connection — disconnect first.' });
    }

    deleteConnection(req.params.id);
    queue.emit('connection:deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

router.post('/connections/:id/connect', async (req, res) => {
  try {
    const conn = getConnection(req.params.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    await sshRegistry.connect(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err).replace(/^Error:\s*/, '') });
  }
});

// Runs left on the host that no token is tracking (e.g. after a lost session).
router.get('/connections/:id/orphans', async (req, res) => {
  try {
    if (!getConnection(req.params.id)) return res.status(404).json({ error: 'Connection not found' });
    res.json(await queue.listOrphans(req.params.id));
  } catch (err) {
    res.status(400).json({ error: String(err).replace(/^Error:\s*/, '') });
  }
});

router.post('/connections/:id/orphans/:name/stop', async (req, res) => {
  try {
    await queue.stopOrphan(req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err).replace(/^Error:\s*/, '') });
  }
});

router.post('/connections/:id/disconnect', async (req, res) => {
  try {
    await sshRegistry.disconnect(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function testSshParams(params: {
  host: string;
  port: number;
  username: string;
  auth_type: string;
  private_key?: string;
  password?: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new Client();

    const timer = setTimeout(() => {
      client.end();
      reject(new Error('Connection timed out after 10s'));
    }, 10_000);

    client.once('ready', () => {
      clearTimeout(timer);
      client.end();
      resolve();
    });

    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    const cfg: ConnectConfig = {
      host:     params.host,
      port:     params.port,
      username: params.username,
      ...(params.auth_type === 'key' && params.private_key
        ? { privateKey: params.private_key }
        : {}),
      ...(params.auth_type === 'password' && params.password
        ? { password: params.password }
        : {}),
    };

    try {
      client.connect(cfg);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

export { router as apiRouter };
