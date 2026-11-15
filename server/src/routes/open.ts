import { Hono } from 'hono';
import { z } from 'zod';
import type { EventBus } from '../events.js';
import { LinkFrameChecker } from '../link-frame.js';

// Allowlist of URL schemes the toast is willing to hand to window.open.
// Rejects javascript:, data:, file:, and anything else exotic — those
// are real footguns when the daemon is reachable beyond localhost (port
// forwarding, reverse proxies, etc.) and a "click to pwn yourself"
// toast is exactly the kind of thing OSS users shouldn't have to think
// about.
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

const UrlSchema = z
  .string()
  .min(1)
  .refine(
    (raw) => {
      try {
        return ALLOWED_SCHEMES.has(new URL(raw).protocol);
      } catch {
        return false;
      }
    },
    { message: 'url must use http, https, or mailto scheme' },
  );

const BodySchema = z.object({
  url: UrlSchema,
  tab_id: z.string().optional(),
  pane_id: z.string().optional(),
});

/**
 * `POST /api/open/external` — request that the connected web UI(s) open
 * a URL in a real browser tab (window.open), not as an iframe pane. The
 * server doesn't do the opening; it emits an `external_url.open` event
 * on the bus and the browser handles it as a click-to-open toast so the
 * window.open() call lands inside a user-gesture handler (popup-blocker
 * safe).
 *
 * When the CLI is invoked inside a muxpad pane, MUXPAD_TAB_ID and
 * MUXPAD_PANE_ID are injected automatically:
 *   - `tab_id` scopes the toast to clients currently viewing that tab.
 *   - `pane_id` is passed through unchanged; the web client looks it up
 *     in its own pane list and produces a display label via the same
 *     function the chrome uses (single source of truth).
 */
export function openRoutes(deps: { events: EventBus; linkFrames?: LinkFrameChecker }): Hono {
  const app = new Hono();
  const linkFrames = deps.linkFrames ?? new LinkFrameChecker();

  /**
   * `GET /api/open/frame?url=…&parent=…` — may the chat's link sheet show this
   * page in an iframe on `parent` (the page's own origin)? `{frame, reason}`;
   * a no means "hand it to the OS browser". See link-frame.ts.
   */
  app.get('/frame', async (c) => {
    const url = c.req.query('url') ?? '';
    const parent = c.req.query('parent') ?? '';
    if (!UrlSchema.safeParse(url).success || url.length > 4096)
      return c.json({ frame: false, reason: 'not an http(s) url' });
    return c.json(await linkFrames.check(url, parent));
  });

  app.post('/external', async (c) => {
    const body = BodySchema.parse(await c.req.json().catch(() => ({})));
    deps.events.emit({
      type: 'external_url.open',
      url: body.url,
      ...(body.tab_id !== undefined ? { tab_id: body.tab_id } : {}),
      ...(body.pane_id !== undefined ? { pane_id: body.pane_id } : {}),
    });
    return c.body(null, 202);
  });

  return app;
}
