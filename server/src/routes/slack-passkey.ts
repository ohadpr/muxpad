import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { slackBrokerRequest } from '../slack-broker.js';
/** Transport only. Neither pane metadata, Origin nor this process authorizes a decision. */
export function slackPasskeyRoutes(deps: {
  paneExists: (id: string) => boolean;
  owned: (pane: string) => string[];
  track: (r: Record<string, unknown>) => void;
}) {
  const app = new Hono();
  let active = 0;
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (active >= 8) return c.json({ error: 'Relay busy' }, 429);
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  });
  app.use('*', bodyLimit({ maxSize: 65536 }));
  app.get('/status', async (c) => {
    try {
      return c.json(await slackBrokerRequest('/inline/status', undefined, 3000));
    } catch (e) {
      return (e as { status?: number }).status === 404
        ? c.json({ mode: 'legacy' })
        : c.json({ mode: 'unavailable' }, 503);
    }
  });
  app.get('/pending', async (c) => {
    const pane = c.req.query('pane');
    if (!pane || !deps.paneExists(pane)) return c.json({ error: 'Unknown pane' }, 404);
    const status = await slackBrokerRequest('/inline/status', undefined, 3000);
    if (status.mode !== 'passkey-inline') return c.json({ error: 'Unavailable' }, 409);
    const ids = deps.owned(pane);
    const selected = ids.slice(0, 4);
    const requests: Record<string, unknown>[] = [];
    let index = 0;
    const worker = async () => {
      while (index < selected.length) {
        const id = selected[index++];
        const r = await slackBrokerRequest(`/requests/${id}`, undefined, 3000);
        if (r.id !== id) throw Error('Mismatched request');
        deps.track(r);
        if (r.state === 'pending') requests.push(r);
      }
    };
    await Promise.all([worker(), worker()]);
    return c.json({ pane, requests, more: ids.length > 4, status });
  });
  const paths: Record<string, string> = {
    'registration-options': '/inline/registration/options',
    'registration-verify': '/inline/registration/verify',
    options: '/inline/options',
    decision: '/inline/decision',
    'management-options': '/inline/management/options',
    'management-verify': '/inline/management/verify',
  };
  app.post('/:operation', async (c) => {
    if (!/^application\/json(?:;|$)/i.test(c.req.header('content-type') || ''))
      return c.json({ error: 'JSON required' }, 415);
    const path = paths[c.req.param('operation')];
    if (!path) return c.json({ error: 'Unknown operation' }, 404);
    const wrapper = z
      .object({ body: z.record(z.unknown()) })
      .strict()
      .parse(await c.req.json());
    const result = await slackBrokerRequest(
      path,
      wrapper.body,
      c.req.param('operation') === 'decision' ? 125000 : 35000,
    );
    if (c.req.param('operation') === 'decision') deps.track(result);
    return c.json(result);
  });
  app.onError((e, c) =>
    c.json(
      { error: 'Passkey relay unavailable; no automatic retry' },
      e instanceof HTTPException && e.status === 413 ? 413 : 502,
    ),
  );
  return app;
}
