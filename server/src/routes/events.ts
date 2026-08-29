import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EventBus } from '../events.js';

/**
 * GET /api/events — SSE mirror of the /ws/events stream, the script-friendly
 * subscription from docs/plans/2026-08-21-ceo-pane.md (A5). A bash-driven
 * supervisor (`muxpad watch`, `muxpad agent wait`) can `curl -N` this where
 * it can't hold a WS open.
 *
 * One JSON-encoded MuxpadEvent per `data:` line. `?types=agent_turn,
 * pane.updated` filters server-side so a waiter isn't parsing every
 * decoration update in the mosaic. Comment heartbeats (`: hb`) keep
 * buffering proxies and idle-timeout middleboxes from severing a stream
 * that is legitimately quiet.
 *
 * The initial `: connected` comment is written AFTER the bus subscription
 * is registered — `muxpad agent wait` uses its arrival as the "subscribed"
 * handshake before checking current busy state, which is what closes the
 * missed-event race (state is only trustworthy once events are flowing).
 */

const HEARTBEAT_MS = 15_000;

export function eventsRoutes(deps: { events: EventBus }): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const typesParam = c.req.query('types');
    const types = typesParam
      ? new Set(
          typesParam
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        )
      : null;
    return streamSSE(c, async (stream) => {
      const unsub = deps.events.subscribe((e) => {
        if (types && !types.has(e.type)) return;
        void stream.writeSSE({ data: JSON.stringify(e) });
      });
      const hb = setInterval(() => {
        void stream.write(': hb\n\n');
      }, HEARTBEAT_MS);
      hb.unref?.();
      // Subscription is live — flush the handshake comment (also forces the
      // response headers out immediately, before any event arrives).
      await stream.write(': connected\n\n');
      // Hold the handler open until the client goes away; teardown there.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(hb);
          unsub();
          resolve();
        });
      });
    });
  });

  return app;
}
