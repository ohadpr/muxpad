import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { verifyPaneKey } from '../pane-key.js';
import { slackBrokerRequest, slackBrokerURL } from '../slack-broker.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { slackNoticeDiagnosticRoutes } from './slack-notice-diagnostic.js';
import { slackPasskeyRoutes } from './slack-passkey.js';
import { slackSetupRoutes } from './slack-setup.js';

/** Slack credentials and execution belong exclusively to the protected broker. */
interface Deps {
  db: Database.Database;
  dataDir: string;
}

/** What a refused call is told, and what it is NOT told. */
function refusal(why: string, detail?: string) {
  return { error: { code: 'slack_refused', message: why, detail } } as const;
}

export function slackRoutes(deps: Deps): Hono {
  const app = new Hono();
  app.route('/setup', slackSetupRoutes());
  const workspaces = new WorkspaceStore(deps.db);
  const tabs = new TabStore(deps.db);
  const panes = new PaneStore(deps.db);
  app.route(
    '/notice-diagnostic',
    slackNoticeDiagnosticRoutes((id) => !!panes.getById(id)),
  );

  /** Identify the originating pane for chat-local notices; the broker authorizes Slack. */
  async function authorize(
    paneId: unknown,
    paneKey: unknown,
  ): Promise<
    { ok: true; pane: string } | { ok: false; status: 403 | 400; body: ReturnType<typeof refusal> }
  > {
    if (typeof paneId !== 'string' || !paneId)
      return {
        ok: false,
        status: 400,
        body: refusal('no caller pane — this works only from inside a muxpad pane'),
      };

    // Pane keys route ordinary requests; they are not
    // a security boundary against agents sharing the server OS account.
    if (!verifyPaneKey(paneId, typeof paneKey === 'string' ? paneKey : null))
      return {
        ok: false,
        status: 403,
        body: refusal(
          'this pane cannot prove which workspace it is in',
          'A pane started before muxpad issued per-pane keys has none, and nothing can put one into a running process. Restart this pane (or open a new one) and try again. Setting MUXPAD_PANE_ID by hand will not help — the key is what is checked.',
        ),
      };

    const pane = panes.getById(paneId);
    const tab = pane ? tabs.getById(pane.tab_id) : null;
    const ws = tab ? workspaces.getById(tabs.getWorkspaceId(tab.id) ?? '') : null;
    if (!ws)
      return { ok: false, status: 403, body: refusal('cannot resolve this pane’s workspace') };

    if (!slackBrokerURL())
      return {
        ok: false,
        status: 403,
        body: refusal(
          'Protected Slack broker is not configured',
          'Configure the protected broker; local Slack credentials are unsupported.',
        ),
      };
    return { ok: true, pane: paneId };
  }

  // Advisory ownership comes only from an authenticated action caller, never a
  // status lookup. Payloads and human credentials stay in the protected broker.
  deps.db.exec(
    'CREATE TABLE IF NOT EXISTS slack_approval_notices (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, pane_id TEXT)',
  );
  const columns = deps.db.prepare('PRAGMA table_info(slack_approval_notices)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'pane_id'))
    deps.db.exec('ALTER TABLE slack_approval_notices ADD COLUMN pane_id TEXT');
  // Legacy notices have no provable owner. Retire them instead of broadcasting.
  deps.db.exec('DELETE FROM slack_approval_notices WHERE pane_id IS NULL');
  const remove = deps.db.prepare('DELETE FROM slack_approval_notices WHERE id = ?');
  const saveNotice = deps.db.prepare(
    'INSERT OR REPLACE INTO slack_approval_notices (id, expires, pane_id) VALUES (?, ?, ?)',
  );
  type Notice = { expires: number; pane: string; stale: boolean };
  const pending = new Map<string, Notice>();
  const overflow = new Map<string, number>();
  const noticeUnavailable = new Map<string, number>();
  const rows = deps.db
    .prepare('SELECT id, expires, pane_id FROM slack_approval_notices')
    .all() as Array<{ id: string; expires: number; pane_id: string }>;
  for (const row of rows) {
    if (!panes.getById(row.pane_id) || row.expires <= Date.now()) {
      remove.run(row.id);
      continue;
    }
    if (row.id === `overflow:${row.pane_id}`) overflow.set(row.pane_id, row.expires);
    else if (/^[a-f0-9-]{36}$/.test(row.id) && pending.size < 64)
      pending.set(row.id, { expires: row.expires, pane: row.pane_id, stale: true });
    else remove.run(row.id);
  }
  const forget = (id: string) => {
    remove.run(id);
    pending.delete(id);
  };
  const prune = () => {
    for (const [pane, expires] of noticeUnavailable)
      if (expires <= Date.now() || !panes.getById(pane)) noticeUnavailable.delete(pane);
    for (const [id, notice] of pending)
      if (notice.expires <= Date.now() || !panes.getById(notice.pane)) forget(id);
    for (const [pane, expires] of overflow)
      if (expires <= Date.now() || !panes.getById(pane)) {
        remove.run(`overflow:${pane}`);
        overflow.delete(pane);
      }
  };
  const track = (result: Record<string, unknown>, owner?: string) => {
    if (typeof result.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.id)) return;
    prune();
    const existing = pending.get(result.id);
    const pane = existing?.pane ?? owner;
    if (!pane || !panes.getById(pane)) return;
    if (
      result.state === 'pending' &&
      typeof result.expires === 'number' &&
      Number.isFinite(result.expires) &&
      result.expires > Date.now()
    ) {
      const expires = Math.min(
        result.expires,
        existing?.expires ?? Number.POSITIVE_INFINITY,
        Date.now() + 300_000,
      );
      if (existing || pending.size < 64) {
        saveNotice.run(result.id, expires, pane);
        pending.set(result.id, { expires, pane, stale: false });
      } else {
        const until = Math.max(overflow.get(pane) ?? 0, expires);
        saveNotice.run(`overflow:${pane}`, until, pane);
        overflow.set(pane, until);
      }
    } else if (
      ['verifying', 'executing', 'complete', 'rejected', 'failed', 'expired'].includes(
        String(result.state),
      )
    ) {
      forget(result.id);
    }
  };
  const safeTrack = (result: Record<string, unknown>, owner?: string) => {
    try {
      track(result, owner);
    } catch {
      const pane =
        (typeof result.id === 'string' ? pending.get(result.id)?.pane : undefined) ?? owner;
      if (pane)
        noticeUnavailable.set(
          pane,
          Math.max(
            noticeUnavailable.get(pane) ?? 0,
            Math.min(
              typeof result.expires === 'number' && Number.isFinite(result.expires)
                ? result.expires
                : Date.now() + 300_000,
              Date.now() + 300_000,
            ),
          ),
        );
    }
  };
  const brokerAction = async (action: string, payload: unknown, pane: string) => {
    const result = await slackBrokerRequest(
      '/requests',
      { action, payload },
      action === 'slack.upload' ? 125000 : 35000,
    );
    safeTrack(result, pane);
    return result;
  };
  app.route(
    '/passkey',
    slackPasskeyRoutes({
      paneExists: (id) => !!panes.getById(id),
      owned: (pane) => {
        prune();
        return [...pending].filter(([, v]) => v.pane === pane).map(([id]) => id);
      },
      track: (r) => safeTrack(r),
    }),
  );
  let refreshing: Promise<void> | null = null;
  let nextRefresh = 0;
  let delay = 1500;
  let cursor = 0;
  app.get('/approvals', (c) => {
    c.header('Cache-Control', 'no-store');
    const pane = c.req.query('pane');
    if (!pane) return c.json(refusal('Approval status requires a caller pane'), 400);
    if (!panes.getById(pane)) return c.json(refusal('Unknown caller pane'), 404);
    prune();
    if (!refreshing && pending.size && Date.now() >= nextRefresh) {
      const ids = [...pending.keys()];
      const batch = Array.from(
        { length: Math.min(8, ids.length) },
        (_, i) => ids[(cursor + i) % ids.length],
      );
      cursor = (cursor + batch.length) % ids.length;
      let failed = false;
      let index = 0;
      const worker = async () => {
        while (index < batch.length) {
          const id = batch[index++];
          if (!id) break;
          try {
            const result = await slackBrokerRequest(`/requests/${id}`, undefined, 3000);
            if (result.id !== id) throw Error('Mismatched request status');
            safeTrack(result);
          } catch (error) {
            // A valid GET for a known UUID returns 400/404 when the broker no longer has it.
            const status = (error as { status?: number }).status;
            const notice = pending.get(id);
            if (notice) notice.stale = true;
            if (status === 400 || status === 404) {
              forget(id);
            } else {
              failed = true;
            }
          }
        }
      };
      // Two status calls at most; leave broker capacity for human decisions.
      refreshing = Promise.allSettled([worker(), worker()])
        .then((results) => {
          failed ||= results.some((result) => result.status === 'rejected');
          delay = failed ? Math.min(delay * 2, 30_000) : 1500;
        })
        .catch(() => {
          delay = Math.min(delay * 2, 30_000);
        })
        .finally(() => {
          nextRefresh = Date.now() + delay;
          refreshing = null;
        });
    }
    return c.json({
      pane,
      pending: [...pending.values()].filter((notice) => notice.pane === pane).length,
      incomplete: (overflow.get(pane) ?? 0) > Date.now(),
      stale:
        [...pending.values()].some((notice) => notice.pane === pane && notice.stale) ||
        (noticeUnavailable.get(pane) ?? 0) > Date.now(),
      approval_url: slackBrokerURL() ? `${slackBrokerURL()}/review` : null,
    });
  });

  app.get('/requests/:id', async (c) => {
    const auth = await authorize(c.req.query('pane'), c.req.query('key'));
    if (!auth.ok) return c.json(auth.body, auth.status);
    const id = c.req.param('id');
    if (!/^[a-f0-9-]{36}$/.test(id) || !slackBrokerURL())
      return c.json(refusal('Unknown broker request'), 404);
    try {
      const result = await slackBrokerRequest(`/requests/${id}`);
      if (result.id !== id) throw Error('Mismatched request status');
      safeTrack(result);
      return c.json(result);
    } catch (error) {
      if ([400, 404].includes((error as { status?: number }).status ?? 0)) {
        forget(id);
        return c.json(refusal('Unknown broker request'), 404);
      }
      return c.json(refusal('Protected Slack broker unavailable'), 502);
    }
  });

  app.onError((_error, c) =>
    c.json(
      refusal('Slack request failed; protected broker mode never falls back to local credentials'),
      502,
    ),
  );

  app.post('/post', async (c) => {
    const body = z
      .object({
        pane: z.string(),
        key: z.string(),
        ref: z.string().min(1),
        text: z.string().min(1),
        thread_ts: z.string().optional(),
      })
      .parse(await c.req.json());
    const auth = await authorize(body.pane, body.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'slack.post',
        {
          ref: body.ref,
          text: body.text,
          ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}),
        },
        auth.pane,
      ),
      202,
    );
  });

  app.post('/unpost', async (c) => {
    const body = z
      .object({
        pane: z.string(),
        key: z.string(),
        channel: z.string().min(1),
        ts: z.string().min(1),
      })
      .parse(await c.req.json());
    const auth = await authorize(body.pane, body.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction('slack.unpost', { ref: body.channel, ts: body.ts }, auth.pane),
      202,
    );
  });

  app.get('/read', async (c) => {
    const q = c.req.query();
    const auth = await authorize(q.pane, q.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'slack.read',
        {
          ref: q.ref,
          limit: q.limit,
          ...(q.oldest ? { oldest: q.oldest } : {}),
        },
        auth.pane,
      ),
      202,
    );
  });

  app.get('/search', async (c) => {
    const q = c.req.query();
    const auth = await authorize(q.pane, q.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction('slack.search', { query: q.q, limit: q.limit }, auth.pane),
      202,
    );
  });

  app.get('/channels', async (c) => {
    const auth = await authorize(c.req.query('pane'), c.req.query('key'));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(await brokerAction('slack.channels', {}, auth.pane), 202);
  });

  app.get('/users', async (c) => {
    const q = c.req.query();
    const auth = await authorize(q.pane, q.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(await brokerAction('slack.users', { name: q.name }, auth.pane), 202);
  });
  app.get('/thread', async (c) => {
    const q = c.req.query();
    const auth = await authorize(q.pane, q.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'slack.thread',
        { ref: q.ref, ts: q.ts, limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) },
        auth.pane,
      ),
      202,
    );
  });
  app.post('/dm', async (c) => {
    const b = z
      .object({ pane: z.string(), key: z.string(), user: z.string() })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(await brokerAction('slack.dm', { user: b.user }, auth.pane), 202);
  });
  app.post('/react', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        ref: z.string(),
        ts: z.string(),
        name: z.string(),
        operation: z.enum(['add', 'remove']),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'slack.react',
        { ref: b.ref, ts: b.ts, name: b.name, operation: b.operation },
        auth.pane,
      ),
      202,
    );
  });
  app.post('/edit', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        ref: z.string(),
        ts: z.string(),
        text: z.string(),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction('slack.edit', { ref: b.ref, ts: b.ts, text: b.text }, auth.pane),
      202,
    );
  });
  app.post('/upload', bodyLimit({ maxSize: 14 * 1024 * 1024 }), async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        ref: z.string(),
        filename: z.string().max(200),
        content: z.string().max(13981016),
        text: z.string().max(35000).optional(),
        thread_ts: z.string().optional(),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'slack.upload',
        {
          ref: b.ref,
          filename: b.filename,
          content: b.content,
          text: b.text,
          thread_ts: b.thread_ts,
        },
        auth.pane,
      ),
      202,
    );
  });

  app.get('/token', (c) =>
    c.json({
      set: false,
      hint: null,
      broker: true,
      configured: !!slackBrokerURL(),
      approval_url: slackBrokerURL() ? `${slackBrokerURL()}/review` : null,
    }),
  );
  app.on(['PUT', 'DELETE'], '/token', (c) =>
    c.json(refusal('Manage credentials directly in the protected broker'), 403),
  );
  return app;
}
