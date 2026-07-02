import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import type { PtydClient } from '../ptyd-client/PtydClient.js';
import { takeoverPane } from '../chat/takeover.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';

const RegisterSchema = z.object({
  pane_id: z.string().min(1),
  assistant: z.string().optional(),
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  pid: z.number().int().positive().optional(),
});

const HookSchema = z.object({
  pane_id: z.string().min(1),
  session_id: z.string().min(1),
  source: z.string().optional(),
});

/**
 * Agent-session tracking. Because muxpad owns every Claude launch (the
 * `muxpad claude` wrapper), discovery is deterministic, not fs-watched:
 *   - `POST /register` — the wrapper, at launch, with the minted --session-id.
 *   - `POST /hook` — the SessionStart hook the wrapper installs, on every
 *     start / resume / compact / fork, with the real provider session-id.
 * See docs/plans/2026-07-01-web-chat-session-switching.md.
 */
export function agentSessionsRoutes(deps: { db: Database.Database; ptyd: PtydClient }): Hono {
  const app = new Hono();
  const store = new AgentSessionStore(deps.db);

  // The terminal→chat toggle calls this: stop the Claude TUI (if any) and make
  // chat the driver, so switching the view switches what's underneath too.
  app.post('/:paneId/takeover', async (c) => {
    const res = await takeoverPane(c.req.param('paneId'), store, deps.ptyd);
    return c.json(res, res.ok ? 200 : 409);
  });

  app.post('/register', async (c) => {
    const body = RegisterSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(store.register(body), 201);
  });

  app.post('/hook', async (c) => {
    const body = HookSchema.parse(await c.req.json().catch(() => ({})));
    const session = store.recordSessionId(body.pane_id, body.session_id);
    // Unknown pane = a session muxpad didn't launch. Out of scope; ack softly
    // so the hook (which runs inside Claude) never surfaces an error.
    if (!session) return c.json({ ok: false, reason: 'no agent session for pane' }, 202);
    return c.json(session);
  });

  app.get('/', (c) => c.json(store.list()));

  app.get('/by-pane/:paneId', (c) => {
    const session = store.getByPane(c.req.param('paneId'));
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json(session);
  });

  return app;
}
