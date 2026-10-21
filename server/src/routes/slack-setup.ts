import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { slackBrokerRequest } from '../slack-broker.js';
import { slackSetupStatus } from '../slack-setup.js';
/** Advisory integration diagnostics. Every external call still needs broker approval. */
export function slackSetupRoutes() {
  const app = new Hono();
  const tests = new Map<
    string,
    { id: string | null; expires: number; version: unknown; uncertain?: boolean }
  >();
  let reservation = false;
  let lastCreated = 0;
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 4096 }));
  app.get('/', async (c) => {
    const requested = c.req.query('origin') || new URL(c.req.url).origin;
    let origin: string;
    try {
      const u = new URL(requested);
      if (u.origin !== requested || u.username || u.password) throw Error();
      origin = u.origin;
    } catch {
      return c.json({ error: 'Use an exact muxpad origin' }, 400);
    }
    return c.json(await slackSetupStatus(origin));
  });
  app.post('/test', async (c) => {
    if (!/^application\/json(?:;|$)/i.test(c.req.header('content-type') || ''))
      return c.json({ error: 'JSON required' }, 415);
    const { operationID } = z
      .object({ operationID: z.string().uuid() })
      .strict()
      .parse(await c.req.json());
    for (const [k, v] of tests) if (v.expires < Date.now()) tests.delete(k);
    const prior = tests.get(operationID);
    if (prior)
      return c.json({ testID: operationID, requestID: prior.id, expires: prior.expires }, 202);
    if (reservation || Date.now() - lastCreated < 2000 || tests.size >= 16)
      return c.json(
        { error: 'A check is already running. Check its result before starting another.' },
        429,
      );
    reservation = true;
    tests.set(operationID, {
      id: null,
      expires: Date.now() + 300000,
      version: null,
      uncertain: true,
    });
    lastCreated = Date.now();
    try {
      const version = (await slackBrokerRequest('/health', undefined, 3000)).version;
      const r = await slackBrokerRequest('/requests', { action: 'slack.channels', payload: {} });
      if (
        typeof r.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(r.id) ||
        typeof r.expires !== 'number'
      )
        throw Error('Invalid test request');
      tests.set(operationID, {
        id: r.id,
        expires: Math.min(r.expires, Date.now() + 300000),
        version,
      });
      lastCreated = Date.now();
      return c.json({ testID: operationID, requestID: r.id, expires: r.expires }, 202);
    } catch {
      return c.json(
        {
          testID: operationID,
          requestID: null,
          state: 'uncertain',
          expires: tests.get(operationID)!.expires,
        },
        202,
      );
    } finally {
      reservation = false;
    }
  });
  app.get('/test/:id', async (c) => {
    const t = tests.get(c.req.param('id'));
    if (!t)
      return c.json(
        { error: 'Check not found. Start a new check; no Slack write was attempted.' },
        404,
      );
    if (!t.id) return c.json({ state: 'uncertain', requestID: null, checkedAt: Date.now() });
    if (t.expires <= Date.now())
      return c.json({ state: 'expired', requestID: t.id, checkedAt: Date.now() });
    const r = await slackBrokerRequest(`/requests/${t.id}`, undefined, 3000);
    if (r.id !== t.id || r.action !== 'slack.channels') throw Error('Mismatched diagnostic');
    if (r.state === 'complete' && !Array.isArray((r.result as { channels?: unknown[] })?.channels))
      throw Error('Invalid read-only result');
    const version = (await slackBrokerRequest('/health', undefined, 3000)).version;
    return c.json({
      state: r.state,
      requestID: t.id,
      checkedAt: Date.now(),
      version,
      versionChanged: version !== t.version,
      ...(r.state === 'complete'
        ? {
            channelCount: Array.isArray((r.result as { channels?: unknown[] })?.channels)
              ? (r.result as { channels: unknown[] }).channels.length
              : 0,
          }
        : {}),
      ...(typeof r.error === 'string' ? { error: r.error } : {}),
      // No channel names or message contents are returned by diagnostics.
    });
  });
  // Only an existing diagnostic ID can fetch its pending approval; cannot transfer pane ownership.
  app.get('/test/:id/pending', async (c) => {
    const t = tests.get(c.req.param('id'));
    if (!t || !t.id || t.expires <= Date.now())
      return c.json({
        pane: `setup-${c.req.param('id')}`,
        requests: [],
        more: false,
        status: null,
      });
    const [r, status] = await Promise.all([
      slackBrokerRequest(`/requests/${t.id}`, undefined, 3000),
      slackBrokerRequest('/inline/status', undefined, 3000),
    ]);
    if (r.id !== t.id || r.action !== 'slack.channels') throw Error('Mismatched diagnostic');
    return c.json({
      pane: `setup-${c.req.param('id')}`,
      requests: r.state === 'pending' ? [r] : [],
      more: false,
      status,
    });
  });
  app.onError((_e, c) =>
    c.json(
      {
        error:
          'Live check unavailable. Check service status; do not automatically repeat a Slack action.',
      },
      502,
    ),
  );
  return app;
}
