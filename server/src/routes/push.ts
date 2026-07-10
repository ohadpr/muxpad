import { Hono } from 'hono';
import { z } from 'zod';
import type { PushService } from '../push.js';

// The PushSubscription.toJSON() shape the browser hands us. `keys` carries
// the message-encryption material; without it web-push can't send payloads,
// so reject subscriptions that lack it.
const SubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

/**
 * Web Push subscription management + a manual test hook.
 *
 *   GET    /api/push/vapid-public-key  → { key } (client needs it to subscribe)
 *   POST   /api/push/subscriptions     → store/refresh a subscription
 *   DELETE /api/push/subscriptions     → drop one (by endpoint)
 *   POST   /api/push/test              → send a test notification everywhere
 */
export function pushRoutes(push: PushService): Hono {
  const app = new Hono();

  app.get('/vapid-public-key', (c) => c.json({ key: push.publicKey }));

  app.post('/subscriptions', async (c) => {
    const sub = SubscriptionSchema.parse(await c.req.json().catch(() => ({})));
    push.subscribe(sub);
    return c.json({ ok: true, count: push.count() }, 201);
  });

  app.delete('/subscriptions', async (c) => {
    const body = z
      .object({ endpoint: z.string().min(1) })
      .parse(await c.req.json().catch(() => ({})));
    push.unsubscribe(body.endpoint);
    return c.body(null, 204);
  });

  app.post('/test', async (c) => {
    await push.send({
      title: 'muxpad',
      body: 'Test notification — push is working.',
      url: '/',
      tag: 'muxpad-test',
    });
    return c.json({ ok: true, count: push.count() });
  });

  return app;
}
