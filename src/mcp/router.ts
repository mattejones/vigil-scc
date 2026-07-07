import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import { createMcpServer } from './server.js';

const router = Router();

// One transport + one McpServer instance per connected AI client.
// The SDK enforces a 1:1 relationship between McpServer and Transport.
const transports = new Map<string, StreamableHTTPServerTransport>();

router.all('/', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    if (sessionId && transports.has(sessionId)) {
      // Route to existing session.
      await transports.get(sessionId)!.handleRequest(req, res, req.body);

    } else if (!sessionId && req.method === 'POST') {
      // New session — create a fresh server + transport pair.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) {
          transports.delete(id);
          console.log(`[mcp] session closed: ${id}`);
        }
      };

      transport.onerror = (err) => {
        console.error('[mcp] transport error:', err);
      };

      // Fresh McpServer per session — SDK does not allow reuse across transports.
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
        console.log(`[mcp] session opened: ${transport.sessionId}`);
      }

    } else {
      res.status(400).json({ error: 'Bad request — missing or unknown mcp-session-id' });
    }

  } catch (err) {
    console.error('[mcp] request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal MCP server error' });
    }
  }
});

export { router as mcpRouter };
